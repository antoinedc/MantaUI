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

    private func toolPart(_ id: String, _ messageID: String, tool: String, status: String, input: [String: JSONValue], output: String? = nil, start: Double? = 12000, end: Double? = 12400) -> OpencodePart {
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
        stateObject["time"] = jsonObject(["start": num(1200), "end": num(2400)])
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
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("multica issue get BET-520")], output: "Blocked", start: 12000, end: 12400),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .steps(.rows(let rows)) = blocks[0], rows.count == 1, case .step(let step) = rows[0] else {
            return XCTFail("expected a single-step group")
        }
        XCTAssertEqual(step.verb, "Ran")
        XCTAssertEqual(step.target, "multica issue get BET-520")
        XCTAssertEqual(step.duration, "0.4s")
        XCTAssertEqual(step.status, .completed)
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
        // 2400 - 1200 = 1200ms = 1.2s; a ms-on-the-wire value must not render
        // 1000× inflated ("20m0s") like it did before the ms→s fix.
        XCTAssertEqual(agent.duration, "1.2s")
    }

    /// A task part not yet stamped with `state.metadata.sessionId` (the 
    /// not-started case, see `TranscriptComponents.SubagentSession`) maps to a
    /// SubagentSession whose `childSessionId` is nil — the empty-state case,
    /// which the child screen explains instead of pushing a silent blank.
    func testTaskPartWithoutSessionMapsToSubagentWithNilChildSession() {
        let state: [String: JSONValue] = [
            "status": str("running"),
            "title": str("unblock sweep"),
        ]
        let part = OpencodePart(type: "tool", id: "t1", messageID: "m1", extra: [
            "tool": str("task"),
            "state": jsonObject(state),
        ])
        let agent = ChatSubagentMapper.session(from: part)
        XCTAssertNotNil(agent)
        XCTAssertEqual(agent?.taskName, "unblock sweep")
        XCTAssertNil(agent?.childSessionId,
                     "no state.metadata.sessionId means the child screen shows the empty state")
    }

    // MARK: - Live subagent cards (BET-1085)
    //
    // The box publishes a `stream/subagent` frame per subagent while it runs,
    // and the chat screen builds a live `.subagent` card from it — so the card
    // appears immediately instead of only after the subagent finishes. These
    // pin the running case that the completed-by-default fixtures below never
    // exercised.

    private func runningPayload(_ childSessionId: String = "ses_child") -> StreamSubagentPayload {
        StreamSubagentPayload(
            childSessionId: childSessionId,
            agent: nil,
            description: nil,
            prompt: nil,
            status: "running",
            title: "unblock sweep",
            output: nil,
            truncated: nil,
            durationMs: 1200,
            runningCount: nil,
            model: nil
        )
    }

    /// A `task` part inside a still-in-flight assistant message (`time.completed
    /// == nil`) yields no `.subagent` row from the canonical mapper. Pins the
    /// skip at ChatModels.swift:267 as intentional — the live card is the only
    /// in-flight surface, and un-skipping would render every streaming answer
    /// twice.
    func testTaskPartInFlightMessageProducesNoCanonicalSubagent() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            taskPart("t1", "m1", childID: "ses_child", title: "sweep", status: "running"),
        ], completed: false)]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertTrue(blocks.isEmpty,
                      "an in-flight assistant message must not emit a canonical subagent row")
    }

    func testLiveSubagentAppendsRunningCard() {
        let blocks = ChatTranscriptMapper.appendingLive(tools: [], subagents: [runningPayload()], to: [])
        guard case .steps(.rows(let rows)) = blocks.last, rows.count == 1, case .subagent(let agent) = rows[0] else {
            return XCTFail("expected exactly one live subagent row")
        }
        XCTAssertEqual(agent.taskName, "unblock sweep")
        XCTAssertEqual(agent.childSessionId, "ses_child")
        XCTAssertEqual(agent.status, .running)
        XCTAssertEqual(agent.duration, "1.2s")
    }

    func testLiveSubagentCompletedIsNotAppended() {
        let done = StreamSubagentPayload(
            childSessionId: "ses_child", agent: nil, description: nil, prompt: nil,
            status: "completed", title: "sweep", output: nil, truncated: nil,
            durationMs: nil, runningCount: nil, model: nil
        )
        let blocks = ChatTranscriptMapper.appendingLive(tools: [], subagents: [done], to: [])
        XCTAssertTrue(blocks.isEmpty,
                      "a finished subagent belongs to the canonical transcript, not the live feed")
    }

    func testLiveSubagentDedupedAgainstCanonicalRow() {
        let canonical = SubagentSession(taskName: "sweep", status: .running, duration: nil, transcript: [], childSessionId: "ses_child")
        let blocks: [TranscriptBlock] = [.steps(.rows([.subagent(canonical)]))]
        let merged = ChatTranscriptMapper.appendingLive(tools: [], subagents: [runningPayload()], to: blocks)
        guard case .steps(.rows(let rows)) = merged[0] else {
            return XCTFail("expected a steps group")
        }
        XCTAssertEqual(rows.count, 1,
                       "a live card whose id the canonical transcript already owns must not be appended")
    }

    func testLiveTaskToolRowIsSuppressed() {
        let task = LiveTool(idx: "t1", callID: "toolu_1", name: "task", presentationHint: "Find the skill", status: "running")
        let taskBlocks = ChatTranscriptMapper.appendingLive(tools: [task], subagents: [], to: [])
        XCTAssertTrue(taskBlocks.isEmpty,
                      "the redundant task tool row must not render — the subagent frame owns the card")

        let bash = LiveTool(idx: "t2", callID: "toolu_2", name: "bash", presentationHint: "run tests", status: "running")
        let bashBlocks = ChatTranscriptMapper.appendingLive(tools: [bash], subagents: [], to: [])
        guard case .steps(.rows(let rows)) = bashBlocks[0], rows.count == 1, case .step = rows[0] else {
            return XCTFail("a non-task live tool must still append a step row")
        }
    }

    func testSubagentIdIsUniquePerCallWithoutChildSession() {
        func part(_ id: String, _ callID: String) -> OpencodePart {
            let state: [String: JSONValue] = ["status": str("running"), "title": str("sweep")]
            return OpencodePart(type: "tool", id: id, messageID: "m1", extra: [
                "tool": str("task"),
                "callID": str(callID),
                "state": jsonObject(state),
            ])
        }
        let a = ChatSubagentMapper.session(from: part("t1", "toolu_1"))
        let b = ChatSubagentMapper.session(from: part("t2", "toolu_2"))
        XCTAssertNotNil(a)
        XCTAssertNotNil(b)
        XCTAssertNil(a?.childSessionId)
        XCTAssertNil(b?.childSessionId)
        XCTAssertNotEqual(a?.id, b?.id,
                          "two task parts with different call ids must not collide on the same row id")
    }

    func testSubagentEqualityTracksStatusAndDuration() {
        let base = SubagentSession(taskName: "sweep", status: .running, duration: "1m12s", transcript: [])
        let same = SubagentSession(taskName: "sweep", status: .running, duration: "1m12s", transcript: [])
        XCTAssertEqual(base, same)

        let differentStatus = SubagentSession(taskName: "sweep", status: .done, duration: "1m12s", transcript: [])
        XCTAssertNotEqual(base, differentStatus, "a changed status is a change the diff must see")

        let differentDuration = SubagentSession(taskName: "sweep", status: .running, duration: "2m01s", transcript: [])
        XCTAssertNotEqual(base, differentDuration, "a changed duration is a change the diff must see")

        // `transcript` is deliberately excluded from equality — it is content
        // the destination screen reads, not something that defines the row.
        let withTranscript = SubagentSession(taskName: "sweep", status: .running, duration: "1m12s", transcript: [.prose("x", at: nil)])
        XCTAssertEqual(base, withTranscript, "equality must not depend on transcript content")
    }

    /// Ownership moved to the child screen (BET-1024): a store constructed for
    /// a child session id is no longer placed in a parent-owned registry, so
    /// two screens opened on the same child id get two INDEPENDENT stores
    /// rather than a shared parent-cached one that a push/dismiss can destroy.
    @MainActor
    func testTwoChildStoresForKeyAreIndependentInstances() {
        let eventStore = MantaEventStore()
        let api = MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!)
        let a = ChatSessionStore(sessionId: "ses_child", eventStore: eventStore, api: api, isReadOnly: true)
        let b = ChatSessionStore(sessionId: "ses_child", eventStore: eventStore, api: api, isReadOnly: true)
        XCTAssertFalse(a === b,
                       "two stores for the same child session id must be independent objects, not shared parent-registry state")
        XCTAssertEqual(a.sessionId, "ses_child")
        XCTAssertEqual(b.sessionId, "ses_child")
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

    // MARK: - Row id uniqueness (loadEarlier crash regression)
    //
    // `stableScrollID` is content-derived and wire content repeats: identical
    // prose sharing a message timestamp, identical user prompts with no
    // `time.created`. A duplicate row id traps MessagingUI's diff
    // (`Dictionary(uniqueKeysWithValues:)`) the moment loadEarlier() widens
    // the window over the colliding pair — the "crash when scrolling up after
    // loading previous messages" bug. `uniqueTranscriptRows` must therefore
    // never emit two rows with the same id, whatever the blocks contain.

    func testDuplicateProseBlocksGetUniqueRowIDs() {
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        let blocks: [TranscriptBlock] = [
            .prose("Done.", at: at),
            .prose("Done.", at: at),
            .prose("Done.", at: at),
        ]
        let rows = uniqueTranscriptRows(blocks)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(Set(rows.map(\.id)).count, 3,
                       "identical prose blocks must not share a row id")
    }

    func testDuplicateUserBlocksWithNilTimeGetUniqueRowIDs() {
        let blocks: [TranscriptBlock] = [
            .user("yes", at: nil),
            .user("yes", at: nil),
        ]
        let rows = uniqueTranscriptRows(blocks)
        XCTAssertEqual(Set(rows.map(\.id)).count, 2,
                       "identical user prompts with missing timestamps must not share a row id")
    }

    func testUniqueRowIDsAreDeterministicAcrossRebuilds() {
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        let blocks: [TranscriptBlock] = [
            .user("go", at: nil),
            .prose("Done.", at: at),
            .prose("Done.", at: at),
        ]
        let first = uniqueTranscriptRows(blocks).map(\.id)
        let second = uniqueTranscriptRows(blocks).map(\.id)
        XCTAssertEqual(first, second,
                       "the same block order must reproduce the same row ids so the diff stays stable")
    }

    func testUniqueRowIDsKeepBareIdForFirstOccurrence() {
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        let blocks: [TranscriptBlock] = [.prose("A", at: at), .prose("B", at: at)]
        let rows = uniqueTranscriptRows(blocks)
        XCTAssertEqual(rows.map(\.id), blocks.map(\.stableScrollID),
                       "non-colliding blocks must keep their content-stable ids unchanged")
    }

    // MARK: - Blocking-card row identity (BET-1214)
    //
    // Permission / plan / question cards now live in the transcript tail. They
    // key their row id on the REQUEST id (stable + unique) rather than hashing
    // content, so an edited card text mid-flight never changes the row's
    // identity (which would delete+insert the card in the list).

    private func cardPermission(_ id: String) -> PermissionRequest {
        PermissionRequest(id: id, sessionID: "ses", permission: "Shell", patterns: nil, always: nil, metadata: nil, tool: nil)
    }

    private func cardQuestion(_ id: String) -> QuestionRequest {
        QuestionRequest(id: id, sessionID: "ses", questions: [], tool: nil, requestId: nil)
    }

    func testCardStableScrollIDsAreStableAcrossRebuilds() {
        let blocks: [TranscriptBlock] = [
            .permission(cardPermission("p1")),
            .planExit(cardQuestion("q1")),
            .question(cardQuestion("q2")),
        ]
        let first = uniqueTranscriptRows(blocks).map(\.id)
        let second = uniqueTranscriptRows(blocks).map(\.id)
        XCTAssertEqual(first, second,
                       "card ids must be stable across rebuilds so the diff stays stable")
    }

    func testPlanExitAndQuestionCardsDifferForSameRequestId() {
        let q = cardQuestion("shared")
        XCTAssertNotEqual(
            TranscriptBlock.planExit(q).stableScrollID,
            TranscriptBlock.question(q).stableScrollID,
            "a plan-exit card and a generic question card must never share a row id"
        )
    }

    func testCardKindsDoNotCollideOnAnIdenticalId() {
        let rows = uniqueTranscriptRows([
            .permission(cardPermission("x")),
            .planExit(cardQuestion("x")),
            .question(cardQuestion("x")),
        ])
        XCTAssertEqual(Set(rows.map(\.id)).count, 3,
                       "three card kinds sharing an id string must still be distinct rows")
    }

    func testPermissionCardIDsAreStableAndUniquePerRequest() {
        let rows = uniqueTranscriptRows([
            .permission(cardPermission("a")),
            .permission(cardPermission("b")),
        ])
        XCTAssertEqual(rows.map(\.id), ["pma", "pmb"],
                       "permission row ids key on the request id")
    }

    // MARK: - Step-group identity (BET-1103)
    //
    // A step group grows by appending rows. Its id must therefore be fixed for the
    // life of the group: an id derived from ALL row ids changes on every new step,
    // so the diff sees a different row and deletes + re-inserts the whole group on
    // every tool call — visible jank, and the remove/insert traffic behind the
    // `_TiledView.applyChange` crashes.

    private func step(_ id: String) -> StepGroupRow {
        .step(ToolStep(id: id, verb: "Read", target: "a.swift",
                       duration: "0.4s", status: .completed, output: nil))
    }

    func testStepGroupIDIsUnchangedWhenAStepIsAppended() {
        let before = TranscriptBlock.steps(.rows([step("call-1")]))
        let after = TranscriptBlock.steps(.rows([step("call-1"), step("call-2")]))
        XCTAssertEqual(before.stableScrollID, after.stableScrollID,
                       "appending a step must not change the group's id, or the whole group is deleted and re-inserted")
    }

    func testStepGroupIDIsUnchangedWhenTheGroupRollsUp() {
        let rows = [step("call-1"), step("call-2"), step("call-3")]
        let plain = TranscriptBlock.steps(.rows(rows))
        let rolled = TranscriptBlock.steps(.rollup(summary: "▸ 3 steps", rows: rows))
        XCTAssertEqual(plain.stableScrollID, rolled.stableScrollID,
                       "rolling up is the same group and must be an in-place update, not a remove + insert")
    }

    func testDifferentStepGroupsGetDifferentIDs() {
        let a = TranscriptBlock.steps(.rows([step("call-1")]))
        let b = TranscriptBlock.steps(.rows([step("call-9")]))
        XCTAssertNotEqual(a.stableScrollID, b.stableScrollID,
                          "two distinct step groups must not share an id")
    }

    func testEmptyStepGroupsStillGetUniqueRowIDs() {
        let blocks: [TranscriptBlock] = [.steps(.rows([])), .steps(.rows([]))]
        let rows = uniqueTranscriptRows(blocks)
        XCTAssertEqual(Set(rows.map(\.id)).count, 2,
                       "uniqueTranscriptRows must still de-duplicate empty step groups")
    }

    // MARK: - Step disclosure (BET-823)

    func testStepDisclosureStateDefaults() {
        // A running tool tails its output; a live approval/failure past the
        // turn never auto-collapses; a completed or pending step reads collapsed.
        XCTAssertTrue(StepDisclosure.expanded(status: .running, userToggled: nil))
        XCTAssertTrue(StepDisclosure.expanded(status: .awaitingApproval, userToggled: nil))
        XCTAssertTrue(StepDisclosure.expanded(status: .error, userToggled: nil))
        XCTAssertTrue(StepDisclosure.expanded(status: .denied, userToggled: nil))
        XCTAssertFalse(StepDisclosure.expanded(status: .completed, userToggled: nil))
        XCTAssertFalse(StepDisclosure.expanded(status: .pending, userToggled: nil))
    }

    func testStepDisclosureUserIntentWins() {
        // A row the user opened stays open even when its state would collapse it.
        XCTAssertTrue(StepDisclosure.expanded(status: .completed, userToggled: true))
        XCTAssertTrue(StepDisclosure.expanded(status: .pending, userToggled: true))
        // A row the user closed stays closed even when its state would expand it.
        XCTAssertFalse(StepDisclosure.expanded(status: .running, userToggled: false))
        XCTAssertFalse(StepDisclosure.expanded(status: .error, userToggled: false))
        XCTAssertFalse(StepDisclosure.expanded(status: .awaitingApproval, userToggled: false))
    }

    // MARK: - Live tools merged into the transcript (BET-823)

    func testLiveToolAppendsToLastStepsGroup() {
        let canonical = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: canonical)
        let live = [LiveTool(idx: "t2", callID: "toolu_2", name: "read", presentationHint: "Read a.ts", status: "running")]
        let merged = ChatTranscriptMapper.appendingLive(tools: live, subagents: [], to: blocks)
        guard case .steps(.rows(let rows)) = merged[0], rows.count == 2,
              case .step(let step) = rows[0], case .step(let liveStep) = rows[1] else {
            return XCTFail("expected both steps in one group")
        }
        XCTAssertEqual(step.status, .completed)
        XCTAssertEqual(liveStep.id, "toolu_2", "the live step is keyed by its callID")
        XCTAssertEqual(liveStep.status, .running)
        XCTAssertEqual(liveStep.verb, "Read")
        XCTAssertEqual(liveStep.target, "Read a.ts")
    }

    func testLiveToolSkipsWhenCanonicalCounterpartExists() {
        // A live tool whose callID the transcript already owns must not be
        // appended a second time — the canonical step takes over in place.
        let canonical = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: canonical)
        let live = [LiveTool(idx: "t1", callID: "t1", name: "bash", presentationHint: nil, status: "running")]
        let merged = ChatTranscriptMapper.appendingLive(tools: live, subagents: [], to: blocks)
        guard case .steps(.rows(let rows)) = merged[0] else {
            return XCTFail("expected a steps group")
        }
        XCTAssertEqual(rows.count, 1, "the canonical step owns the row; no duplicate live row")
    }

    func testLiveToolCreatesGroupWhenNoStepsExist() {
        let blocks = ChatTranscriptMapper.blocks(from: [])
        let live = [LiveTool(idx: "t1", callID: "toolu_1", name: "bash", presentationHint: nil, status: "running")]
        let merged = ChatTranscriptMapper.appendingLive(tools: live, subagents: [], to: blocks)
        guard case .steps(.rows(let rows)) = merged.last else {
            return XCTFail("expected a steps group to be created at the tail")
        }
        XCTAssertEqual(rows.count, 1)
    }

    func testAppendingLiveIsANoOpWhenNothingToAppend() {
        let blocks = ChatTranscriptMapper.blocks(from: [])
        XCTAssertTrue(ChatTranscriptMapper.appendingLive(tools: [], subagents: [], to: blocks).isEmpty)
    }
}
