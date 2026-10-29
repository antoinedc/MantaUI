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
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        guard case .user(let text, _) = blocks[0] else {
            return XCTFail("expected .user, got \(blocks[0])")
        }
        XCTAssertEqual(text, "check bet-520")
    }

    func testAssistantTextMapsToProse() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "Checking metadata.")])]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        guard case .prose(let text, _, _) = blocks[0] else {
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
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns([msg]))
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
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns([msg]))
        guard case .prose(_, let at, _) = blocks[0] else {
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
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
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

    // MARK: - Activity runs (spec §1)

    /// The single run a transcript's only activity block holds.
    private func onlyRun(_ blocks: [TranscriptBlock], file: StaticString = #filePath, line: UInt = #line) -> ToolRun? {
        guard blocks.count == 1, case .activity(let run) = blocks[0] else {
            XCTFail("expected exactly one activity run, got \(blocks)", file: file, line: line)
            return nil
        }
        return run
    }

    func testBashCallMapsToAnActivityRunWithItsCommandAsDetail() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("multica issue get BET-520")], output: "Blocked", start: 12000, end: 12400),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))) else { return }
        XCTAssertEqual(run.id, "t1", "a run's id is its first part's id")
        XCTAssertEqual(run.parts.count, 1)
        // The call's wording is the box's (`part.view.activity`); the phone keeps the status and the detail.
        XCTAssertEqual(ToolActivity.status(of: run.parts[0]), .completed)
        XCTAssertEqual(ToolActivity.detail(of: run.parts[0]).command, "multica issue get BET-520")
        XCTAssertEqual(ToolActivity.durationSeconds(of: run.parts[0]) ?? -1, 0.4, accuracy: 0.0001)
        XCTAssertEqual(ToolActivity.detail(of: run.parts[0]).output, "Blocked")
    }

    func testRunningReadCallReadsAsRunning() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "running", input: ["filePath": str("pr-body.md")], output: nil, start: nil, end: nil),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))) else { return }
        XCTAssertEqual(ToolActivity.status(of: run.parts[0]), .running)
        XCTAssertNil(ToolActivity.durationSeconds(of: run.parts[0]), "a timeless running call has no duration")
    }

    // MARK: - Subagent

    func testTaskPartMapsToATaskCallInTheRunAndToASubagentWithChildSession() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            taskPart("t1", "m1", childID: "ses_child", title: "unblock sweep", status: "running"),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))),
              let agent = ChatSubagentMapper.session(from: run.parts[0]) else {
            return XCTFail("expected a task call that maps to a subagent")
        }
        XCTAssertTrue(ToolActivity.isTask(run.parts[0]))
        XCTAssertEqual(agent.taskName, "unblock sweep")
        XCTAssertEqual(agent.childSessionId, "ses_child")
        XCTAssertEqual(agent.status, .running)
        // 2400 - 1200 = 1200ms = 1.2s; a ms-on-the-wire value must not render
        // 1000× inflated ("20m0s") like it did before the ms→s fix.
        XCTAssertEqual(agent.duration, "1.2s")
    }

    /// An ERRORED task reads as failed. It used to read as running (spec §5, P5).
    func testErroredTaskPartMapsToAFailedSubagent() {
        let part = taskPart("t1", "m1", childID: "ses_child", title: "sweep", status: "error")
        XCTAssertEqual(ChatSubagentMapper.session(from: part)?.status, .failed)
        XCTAssertEqual(ChatSubagentMapper.session(from: part)?.statusText, "failed")
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

    /// A task part (or a live frame) with no `state.title` is named from its input
    /// description rather than the generic "subagent".
    func testTaskNameFallsBackToTheInputDescription() {
        let state: [String: JSONValue] = [
            "status": str("running"),
            "input": jsonObject(["description": str("find the thing")]),
        ]
        let part = OpencodePart(type: "tool", id: "t1", messageID: "m1", extra: [
            "tool": str("task"),
            "state": jsonObject(state),
        ])
        XCTAssertEqual(ChatSubagentMapper.session(from: part)?.taskName, "find the thing")
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
    /// == nil`) yields no run from the canonical mapper. Pins the
    /// in-flight skip as intentional — the live card is the only
    /// in-flight surface, and un-skipping would render every streaming answer
    /// twice.
    func testTaskPartInFlightMessageProducesNoCanonicalSubagent() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            taskPart("t1", "m1", childID: "ses_child", title: "sweep", status: "running"),
        ], completed: false)]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        XCTAssertTrue(blocks.isEmpty,
                      "an in-flight assistant message must not emit a canonical subagent row")
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

    // MARK: - This turn's finished live calls (activity-parity live fix)

    // MARK: - Run grouping (spec §1.1; the rules are the desktop's layoutTranscript)

    func testConsecutiveCallsAreOneRunNotARollupOfThreeOrMore() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))) else { return }
        XCTAssertEqual(run.parts.count, 2, "two calls are ONE run — the 3+ roll-up rule is gone")
        XCTAssertEqual(run.view.calls, 2, "the run's summary is the box's; here it carries the call count")
    }

    func testAMixedRunSummarisesByCategoryInFirstSeenOrder() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
            toolPart("t3", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))) else { return }
        XCTAssertEqual(run.view.calls, 3)
    }

    /// A run SPANS assistant messages (opencode writes one message per model
    /// step): it belongs to the message it starts in, and the messages it absorbs
    /// draw NO block of their own.
    func testARunSpansAssistantMessagesAndAbsorbedMessagesDrawNothing() {
        let msgs = [
            message(id: "m1", role: "assistant", parts: [
                toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            ]),
            message(id: "m2", role: "assistant", parts: [
                toolPart("t2", "m2", tool: "bash", status: "completed", input: ["command": str("ls")]),
            ]),
            message(id: "m3", role: "assistant", parts: [
                toolPart("t3", "m3", tool: "read", status: "completed", input: ["filePath": str("c.ts")]),
                textPart("p1", "m3", "Done."),
            ]),
        ]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        XCTAssertEqual(blocks.count, 2, "one run + one prose, got \(blocks)")
        guard case .activity(let run) = blocks[0], case .prose = blocks[1] else {
            return XCTFail("expected [.activity, .prose], got \(blocks)")
        }
        XCTAssertEqual(run.parts.map(\.id), ["t1", "t2", "t3"])
        XCTAssertEqual(run.id, "t1", "the run's id is its first part's id, which stays stable as the run grows")
    }

    func testTextEndsARunAndAnotherRunStartsAfterIt() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            textPart("p1", "m1", "Now the second."),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        XCTAssertEqual(blocks.count, 3)
        guard case .activity(let a) = blocks[0], case .prose = blocks[1], case .activity(let b) = blocks[2] else {
            return XCTFail("expected [.activity, .prose, .activity], got \(blocks)")
        }
        XCTAssertEqual([a.id, b.id], ["t1", "t2"])
    }

    func testAUserMessageEndsARun() {
        let msgs = [
            message(id: "m1", role: "assistant", parts: [
                toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            ]),
            message(id: "u1", role: "user", parts: [textPart("up", "u1", "next")]),
            message(id: "m2", role: "assistant", parts: [
                toolPart("t2", "m2", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
            ]),
        ]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(BoxViewFixture.stamp(msgs)))
        XCTAssertEqual(blocks.count, 4, "the second run's turn (after the user message) ends with its footer")
        guard case .activity(let a) = blocks[0], case .user = blocks[1], case .activity(let b) = blocks[2],
              case .turnFooter = blocks[3] else {
            return XCTFail("expected [.activity, .user, .activity, .turnFooter], got \(blocks)")
        }
        XCTAssertNotEqual(a.id, b.id)
    }

    /// Todo-list writes never appear as tool calls.
    func testTodoWritesAreNotToolCalls() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "todowrite", status: "completed", input: [:]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))) else { return }
        XCTAssertEqual(run.parts.map(\.id), ["t2"])
    }

    /// A newline-only text part between two calls draws nothing (BET-632), so it
    /// must not split the run in two.
    func testBlankTextBetweenCallsDoesNotSplitTheRun() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            textPart("p1", "m1", "\n"),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))) else { return }
        XCTAssertEqual(run.parts.count, 2)
    }

    /// A run that spans messages must keep an id that survives a refetch, and the
    /// rows built from it must pass the duplicate-id guard (spec §7).
    func testRunRowIdsAreStableAndUnique() {
        let msgs = [
            message(id: "m1", role: "assistant", parts: [
                toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            ]),
            message(id: "m2", role: "assistant", parts: [
                toolPart("t2", "m2", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
                textPart("p1", "m2", "x"),
                toolPart("t3", "m2", tool: "read", status: "completed", input: ["filePath": str("c.ts")]),
            ]),
        ]
        let first = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs)))
        let second = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs)))
        XCTAssertEqual(first.map(\.id), second.map(\.id), "a refetch of the same window reproduces the same ids")
        XCTAssertEqual(first.count, 3)
        XCTAssertEqual(first[0].id, "run-t1")
        XCTAssertEqual(first[2].id, "run-t3")
        XCTAssertEqual(Set(first.map(\.id)).count, first.count)
    }

    func testGrowingARunKeepsItsRowId() {
        let one = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
        ])]
        let two = one + [message(id: "m2", role: "assistant", parts: [
            toolPart("t2", "m2", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let before = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(one))).map(\.id)
        let after = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(two))).map(\.id)
        XCTAssertEqual(before, ["run-t1"])
        XCTAssertEqual(after, ["run-t1"], "a run that grows (even across messages) is an in-place update of the same row")
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
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        XCTAssertEqual(blocks.count, 2, "expected prose + a run only, got \(blocks)")
        guard case .prose = blocks[0], case .activity = blocks[1] else {
            return XCTFail("expected [.prose, .activity], got \(blocks)")
        }
    }

    func testWhitespaceOnlyTextPartIsBlank() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "   \n  ")])]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        XCTAssertTrue(blocks.isEmpty, "whitespace-only text must be skipped, got \(blocks)")
    }

    func testBlankTrailingTextAfterStepsIsSkipped() {
        // A blank text part AFTER a tool run must not leave a stray `.prose`
        // block trailing the steps group (another false gap on the next block).
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
            textPart("p1", "m1", "\n\n"),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        XCTAssertEqual(blocks.count, 1, "expected only the run, got \(blocks)")
        guard case .activity = blocks[0] else {
            return XCTFail("expected .activity, got \(blocks)")
        }
    }

    func testUserBlankPartDoesNotAddParagraphInsideBand() {
        let msgs = [message(id: "m1", role: "user", parts: [
            textPart("p1", "m1", "check bet-520"),
            textPart("p2", "m1", "\n"),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
        guard case .user(let text, _) = blocks[0] else {
            return XCTFail("expected .user, got \(blocks[0])")
        }
        XCTAssertEqual(text, "check bet-520")
    }

    /// A task call is just another call in the run; it does not split it.
    func testATaskCallStaysInsideTheRun() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            taskPart("t2", "m1", childID: "c", title: "sweep", status: "running"),
            toolPart("t3", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))) else { return }
        XCTAssertEqual(run.parts.count, 3)
    }

    // MARK: - Streaming duplication avoidance

    func testIncompleteAssistantMessageIsNotDuplicated() {
        // The running assistant turn (no time.completed) must NOT emit a prose
        // block — its text streams live via `stream.flush` and the store
        // appends it as the in-progress tail. Including it here would double
        // it while streaming.
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "streaming…")], completed: false)]
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs))
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
            guard case .activity(let run) = block else { return [] }
            return run.parts.map(\.id)
        }
    }

    func testStepIdsAreIdenticalAcrossRefetch() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
        ])]
        let first = stepIDs(from: ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs)))
        let second = stepIDs(from: ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs)))
        XCTAssertFalse(first.isEmpty, "expected at least one step id")
        XCTAssertEqual(first, second, "mapping the same transcript twice must yield identical step ids")
    }

    func testStepIdsSurviveAppendingANewMessage() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
        ])]
        let before = stepIDs(from: ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(msgs)))
        let extended = msgs + [message(id: "m2", role: "assistant", parts: [
            toolPart("t3", "m2", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        let after = stepIDs(from: ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(extended)))
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

    // MARK: - Live tools merged into the transcript (BET-823, spec §1)

    // MARK: - The live tail (the box's ordered ledger laid over the canonical blocks, WS11 D11)

    private func liveEntry(
        _ id: String, _ tool: String = "bash", run: String = "t1", segment: String? = nil,
        status: String = "running", child: String? = nil, label: String = "x"
    ) -> LiveRunPart {
        LiveRunPart(
            id: id, callID: id, messageID: "m", runId: run, segmentId: segment, tool: tool, status: status, childSessionId: child,
            activity: TranscriptActivityView(kind: tool == "task" ? .task : .other, status: ActivityStatus.normalize(status),
                                             label: label, target: "", counted: true))
    }

    private func runValue(_ id: String, _ label: String, segments: [TranscriptRunSegment] = []) -> TranscriptRunView {
        TranscriptRunView(id: id, ownerMessageId: "m", rev: TranscriptRunRev(epoch: "E1", gen: 1, seq: 1),
                          summary: TranscriptRunSummary(label: label, calls: 1, failed: 0, tone: .running), segments: segments)
    }

    private func chunk(_ partID: String, _ text: String, field: String = "text") -> StreamTextChunk {
        StreamTextChunk(partID: partID, messageID: "m", field: field, text: text)
    }

    private func tail(
        _ layout: [LiveBlock], parts: [LiveRunPart] = [], runs: [String: TranscriptRunView] = [:], closed: Set<String> = [],
        chunks: [StreamTextChunk] = [], tails: [String: String] = [:], subagents: [StreamSubagentPayload] = [],
        context: TaskStatusContext = .empty, showReasoning: Bool = false, canonical: [TranscriptBlock] = [], running: Bool = false
    ) -> LiveTailResult {
        ChatTranscriptMapper.liveTail(
            layout: layout, runs: runs, parts: parts, closed: closed, chunks: chunks, tails: tails, subagents: subagents,
            taskContext: context, showReasoning: showReasoning, canonical: canonical, running: running)
    }

    private func rowIDs(_ blocks: [TranscriptBlock]) -> [String] { uniqueTranscriptRows(blocks).map(\.id) }

    func testTheLiveTurnDrawsInItsRealOrderToolProseTool() {
        let result = tail(
            [.run(id: "t1", segmentId: "t1"), .text(partID: "a1:text:0", messageID: "a1"), .run(id: "t2", segmentId: "t2")],
            parts: [liveEntry("t1", run: "t1"), liveEntry("t2", run: "t2")],
            runs: ["t1": runValue("t1", "Read a file"), "t2": runValue("t2", "Ran a command")],
            chunks: [chunk("a1:text:0", "Found it.")]
        )
        XCTAssertEqual(rowIDs(result.blocks), ["run-t1", "pa1:text:0", "run-t2"])
        guard case .activity(let first) = result.blocks[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(first.view.label, "Read a file", "the summary is the box's")
    }

    /// The handover: every live row id equals the id of its canonical twin, in the same order, so the turn-end refetch
    /// replaces rows in place and the live tail then has nothing left to draw.
    func testLiveRowIDsEqualTheirCanonicalTwinsSoTheHandoverIsAnInPlaceUpdate() {
        let layout: [LiveBlock] = [.run(id: "t1", segmentId: "t1"), .text(partID: "a1:text:0", messageID: "a1"), .run(id: "t2", segmentId: "t2")]
        let live = tail(layout, parts: [liveEntry("t1", run: "t1"), liveEntry("t2", run: "t2")],
                        chunks: [chunk("a1:text:0", "Found it.")])
        let canonicalMessages = [
            message(id: "u1", role: "user", parts: [textPart("u1:text:0", "u1", "go")]),
            message(id: "a1", role: "assistant", parts: [
                toolPart("t1", "a1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
                textPart("a1:text:0", "a1", "Found it."),
                toolPart("t2", "a1", tool: "bash", status: "completed", input: ["command": str("ls")]),
            ]),
        ]
        let canonical = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns(canonicalMessages))
        let canonicalIDs = rowIDs(canonical)
        XCTAssertEqual(rowIDs(live.blocks), Array(canonicalIDs.dropFirst()), "same ids, same order (after the user band)")

        let after = tail(layout, parts: [liveEntry("t1", run: "t1"), liveEntry("t2", run: "t2")],
                         chunks: [chunk("a1:text:0", "Found it.")], canonical: canonical)
        XCTAssertTrue(after.blocks.isEmpty, "everything the live tail drew is now canonical — nothing is drawn twice")
        XCTAssertTrue(ChatTranscriptMapper.coversLayout(canonical: canonical, layout: layout, showReasoning: false))
    }

    func testAPartlyCanonicalRunIsUpsertedInPlaceNotDuplicated() {
        let canonical = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns([
            message(id: "a1", role: "assistant", parts: [toolPart("t1", "a1", tool: "read", status: "completed", input: ["filePath": str("a.ts")])]),
        ]))
        let result = tail([.run(id: "t1", segmentId: "t1")],
                          parts: [liveEntry("t1", run: "t1", status: "completed"), liveEntry("t2", run: "t1")],
                          runs: ["t1": runValue("t1", "Read 2 files")], canonical: canonical)
        XCTAssertTrue(result.blocks.isEmpty, "no second row for the same run")
        guard result.canonical.count == 1, case .activity(let run) = result.canonical[0] else { return XCTFail("expected the canonical run") }
        XCTAssertEqual(run.id, "t1")
        XCTAssertEqual(run.parts.map(\.id), ["t1", "t2"], "the canonical call stays; the ledger adds only what is missing")
        XCTAssertEqual(run.view.label, "Read 2 files", "the rev-merged summary, never the older one")
    }

    func testTheCanonicalCallWinsOverItsLiveSiblingByPartIDAndByCallID() {
        var canonicalPart = toolPart("t1", "a1", tool: "bash", status: "completed", input: ["command": str("ls")])
        canonicalPart.extra["callID"] = str("c1")
        let canonical = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns([message(id: "a1", role: "assistant", parts: [canonicalPart])]))
        var sameCall = liveEntry("t2", run: "t1", status: "completed")
        sameCall.callID = "c1"
        let result = tail([.run(id: "t1", segmentId: "t1")],
                          parts: [liveEntry("t1", run: "t1", status: "completed"), sameCall, liveEntry("t3", run: "t1")],
                          canonical: canonical)
        guard case .activity(let run) = result.canonical[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(run.parts.map(\.id), ["t1", "t3"])
    }

    func testTheRunAtTheVeryTailIsWithheldForTheWorkingLineWhileTheTurnRuns() {
        let layout: [LiveBlock] = [.run(id: "t1", segmentId: "t1")]
        let parts = [liveEntry("t1", run: "t1")]
        let running = tail(layout, parts: parts, running: true)
        XCTAssertTrue(running.blocks.isEmpty, "the tail run is not a row while the turn runs")
        XCTAssertEqual(running.trailing?.id, "t1")

        let closed = tail(layout, parts: parts, closed: ["t1"], running: true)
        XCTAssertEqual(rowIDs(closed.blocks), ["run-t1"], "a closed run is an ordinary row")
        XCTAssertNil(closed.trailing)

        let idle = tail(layout, parts: parts, running: false)
        XCTAssertEqual(rowIDs(idle.blocks), ["run-t1"])
        XCTAssertNil(idle.trailing)
    }

    func testARunFollowedByLiveProseIsNotTheTailAndANewRunAfterItIs() {
        let layout: [LiveBlock] = [.run(id: "t1", segmentId: "t1"), .text(partID: "a1:text:0", messageID: "a1"), .run(id: "t2", segmentId: "t2")]
        let result = tail(layout, parts: [liveEntry("t1", run: "t1"), liveEntry("t2", run: "t2")],
                          chunks: [chunk("a1:text:0", "hmm")], running: true)
        XCTAssertEqual(rowIDs(result.blocks), ["run-t1", "pa1:text:0"])
        XCTAssertEqual(result.trailing?.id, "t2")
    }

    func testAnUpsertedCanonicalRowAtTheVeryEndBecomesTheTrailingRun() {
        let canonical = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns([
            message(id: "a1", role: "assistant", parts: [toolPart("t1", "a1", tool: "read", status: "completed", input: ["filePath": str("a.ts")])]),
        ]))
        let result = tail([.run(id: "t1", segmentId: "t1")],
                          parts: [liveEntry("t1", run: "t1", status: "completed"), liveEntry("t2", run: "t1")], canonical: canonical, running: true)
        XCTAssertTrue(result.canonical.isEmpty, "withheld from the rows for the working line")
        XCTAssertEqual(result.trailing?.id, "t1")
        XCTAssertEqual(result.trailing?.parts.count, 2)
    }

    func testReasoningSegmentsAreRowsWhenShownAndOneRowWhenHiddenWithTheSameFirstId() {
        let layout: [LiveBlock] = [.run(id: "A", segmentId: "A"), .reasoning(partID: "m:reasoning:0", messageID: "m"), .run(id: "A", segmentId: "B")]
        let parts = [liveEntry("A", run: "A", segment: "A"), liveEntry("B", run: "A", segment: "B")]
        let split = [TranscriptRunSegment(id: "A", summary: TranscriptRunSummary(label: "Read a file")),
                     TranscriptRunSegment(id: "B", summary: TranscriptRunSummary(label: "Ran a command"))]
        let runs = ["A": runValue("A", "Read a file, ran a command", segments: split)]
        let chunks = [chunk("m:reasoning:0", "thinking", field: "reasoning")]
        let shown = tail(layout, parts: parts, runs: runs, chunks: chunks, showReasoning: true)
        XCTAssertEqual(rowIDs(shown.blocks), ["run-A", "rm:reasoning:0", "run-B"])
        let hidden = tail(layout, parts: parts, runs: runs, chunks: chunks, showReasoning: false)
        XCTAssertEqual(rowIDs(hidden.blocks), ["run-A"], "toggling keeps the first row's id")
        guard case .activity(let whole) = hidden.blocks[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(whole.view.label, "Read a file, ran a command")
        XCTAssertEqual(whole.parts.map(\.id), ["A", "B"])
    }

    func testTextTheLedgerDoesNotNameStillShowsKeyedByItsPartAndCanonicalTextIsNotDrawnTwice() {
        // An older box has no ledger at all: streamed text must not disappear.
        let older = tail([], chunks: [chunk("a1:text:0", "streaming")])
        XCTAssertEqual(rowIDs(older.blocks), ["pa1:text:0"])
        // The canonical block for that part replaces it.
        let canonical: [TranscriptBlock] = [.prose("streaming", at: Date(timeIntervalSince1970: 1), partID: "a1:text:0")]
        XCTAssertTrue(tail([], chunks: [chunk("a1:text:0", "streaming")], canonical: canonical).blocks.isEmpty)
        XCTAssertEqual(rowIDs(canonical), ["pa1:text:0"], "a text part's row id is the part id, live or canonical")
    }

    func testALiveTaskCallCarriesItsSubagentAndReadsRunningUntilItFinishes() {
        let call = liveEntry("task1", "task", run: "task1", child: "ses_child")
        let running = tail([.run(id: "task1", segmentId: "task1")], parts: [call], subagents: [runningPayload()])
        guard case .activity(let run)? = running.blocks.last, let agent = ChatSubagentMapper.session(from: run.parts[0]) else {
            return XCTFail("expected a live task call")
        }
        XCTAssertEqual(agent.taskName, "unblock sweep")
        XCTAssertEqual(agent.childSessionId, "ses_child")
        XCTAssertEqual(agent.status, .running)

        var done = call
        done.status = "completed"
        let finished = StreamSubagentPayload(childSessionId: "ses_child", agent: nil, description: nil, prompt: nil, status: "completed",
                                             title: "sweep", output: "all good", truncated: nil, durationMs: nil, runningCount: nil, model: nil)
        guard case .activity(let doneRun)? = tail([.run(id: "task1", segmentId: "task1")], parts: [done], subagents: [finished]).blocks.last,
              let doneAgent = ChatSubagentMapper.session(from: doneRun.parts[0]) else { return XCTFail("expected the task call") }
        XCTAssertEqual(doneAgent.status, .done)
    }

    /// Spec §5: a task whose tool call reads COMPLETED because the work was started in the background stays running until
    /// the child (or its job record) says otherwise.
    func testABackgroundTaskThatReadsCompletedIsRunningThenDone() {
        let started = StreamSubagentPayload(
            childSessionId: "ses_child", agent: nil, description: nil, prompt: nil, status: "completed", title: "sweep",
            output: "<task id=\"1\" state=\"running\">started</task>", truncated: nil, durationMs: nil, runningCount: nil, model: nil)
        func status(_ context: TaskStatusContext) -> SubagentStatus? {
            let result = tail([.run(id: "task1", segmentId: "task1")],
                              parts: [liveEntry("task1", "task", run: "task1", status: "completed", child: "ses_child")],
                              subagents: [started], context: context)
            guard case .activity(let run)? = result.blocks.last else { return nil }
            return ChatSubagentMapper.session(from: run.parts[0])?.status
        }
        XCTAssertEqual(status(TaskStatusContext(childRunning: ["ses_child": true])), .running)
        XCTAssertEqual(status(TaskStatusContext(childRunning: [:])), .running, "no state yet: unknown, still running")
        XCTAssertEqual(status(TaskStatusContext(childRunning: ["ses_child": false])), .done)
    }

    func testALiveDelegateCallReadsRunningWhileItsJobRuns() {
        let started = "Started background job \"ship-gate\" (id 198262c2). It runs in its own session."
        func status(_ ctx: TaskStatusContext) -> ActivityStatus? {
            let result = tail([.run(id: "d1", segmentId: "d1")],
                              parts: [liveEntry("d1", "delegate_delegate", run: "d1", status: "completed")],
                              tails: ["d1": started], context: ctx)
            guard case .activity(let run)? = result.blocks.last else { return nil }
            return ToolActivity.status(of: run.parts[0])
        }
        XCTAssertEqual(status(TaskStatusContext(jobStatusByID: ["198262c2": "running"])), .running)
        XCTAssertEqual(status(TaskStatusContext(jobStatusByID: ["198262c2": "done"])), .completed)
        XCTAssertEqual(status(.empty), .completed, "an unknown job leaves the call as it is")
    }

    func testARunningCallsStdoutTailRidesOnItsPartForTheActivitySheet() {
        let result = tail([.run(id: "t1", segmentId: "t1")], parts: [liveEntry("t1", run: "t1")], tails: ["t1": "one\ntwo\n"])
        guard case .activity(let run)? = result.blocks.last else { return XCTFail("expected a run") }
        XCTAssertEqual(ToolActivity.detail(of: run.parts[0]).output, "one\ntwo\n")
        XCTAssertEqual(TranscriptPartView.of(run.parts[0])?.activity?.label, "x", "the wording on a live part is the box's")
    }

    func testARunWithNoValueYetIsDrawnWithTheNeutralSummary() {
        let result = tail([.run(id: "t1", segmentId: "t1")], parts: [liveEntry("t1", run: "t1")])
        guard case .activity(let run)? = result.blocks.last else { return XCTFail("expected a run") }
        XCTAssertEqual(run.view.label, "Tool activity", "no value yet (epoch unknown): the static label, never wording of the phone's own")
    }

    func testRunViewsAreRefreshedOnTheCanonicalRowsWithoutRemapping() {
        let canonical = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns([
            message(id: "a1", role: "assistant", parts: [toolPart("t1", "a1", tool: "read", status: "completed", input: ["filePath": str("a.ts")])]),
        ]))
        let refreshed = ChatTranscriptMapper.applyingRunViews(canonical, runs: ["t1": runValue("t1", "Read 3 files")], showReasoning: false)
        guard case .activity(let run) = refreshed[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(run.view.label, "Read 3 files")
        XCTAssertEqual(run.id, "t1", "the row id never changes with its summary")
    }

    // MARK: - Task status resolution applied to runs (spec §5)

    func testResolvingTaskStatusesRewritesACompletedBackgroundTaskToRunning() {
        let state: [String: JSONValue] = [
            "status": str("completed"),
            "title": str("sweep"),
            "input": jsonObject([:]),
            "output": str("<task id=\"1\" state=\"running\">started</task>"),
            "metadata": jsonObject(["sessionId": str("ses_child")]),
        ]
        let part = OpencodePart(type: "tool", id: "t1", messageID: "m1", extra: ["tool": str("task"), "state": jsonObject(state)])
        let blocks: [TranscriptBlock] = [.activity(ToolRun(id: "t1", parts: [part], view: TranscriptRunSummary(label: "Ran agent")))]

        let busy = ChatTranscriptMapper.resolvingTaskStatuses(
            blocks, context: TaskStatusContext(childRunning: ["ses_child": true]))
        guard case .activity(let runningRun) = busy[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(ToolActivity.status(of: runningRun.parts[0]), .running)
        XCTAssertEqual(runningRun.view.label, "Ran agent", "resolving a task's status never rewrites the box's run summary")

        let idle = ChatTranscriptMapper.resolvingTaskStatuses(
            blocks, context: TaskStatusContext(childRunning: ["ses_child": false]))
        guard case .activity(let doneRun) = idle[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(ToolActivity.status(of: doneRun.parts[0]), .completed,
                       "the row is upgraded to done once the child reports idle")
    }
}
