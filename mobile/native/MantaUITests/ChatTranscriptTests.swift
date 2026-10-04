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

    // MARK: - Activity runs (spec §1)

    /// The single run a transcript's only activity block holds.
    private func onlyRun(_ blocks: [TranscriptBlock], file: StaticString = #filePath, line: UInt = #line) -> ToolRun? {
        guard blocks.count == 1, case .activity(let run) = blocks[0] else {
            XCTFail("expected exactly one activity run, got \(blocks)", file: file, line: line)
            return nil
        }
        return run
    }

    func testBashCallMapsToAnActivityRunWithItsCommandAsLabel() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("multica issue get BET-520")], output: "Blocked", start: 12000, end: 12400),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)) else { return }
        XCTAssertEqual(run.id, "t1", "a run's id is its first part's id")
        XCTAssertEqual(run.parts.count, 1)
        let activity = ToolActivity.describe(run.parts[0])
        XCTAssertEqual(activity.label, "multica issue get BET-520")
        XCTAssertEqual(activity.status, .completed)
        XCTAssertEqual(ToolActivity.durationSeconds(of: run.parts[0]) ?? -1, 0.4, accuracy: 0.0001)
        XCTAssertEqual(ToolActivity.detail(of: run.parts[0]).output, "Blocked")
    }

    func testRunningReadCallReadsAsRunning() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "running", input: ["filePath": str("pr-body.md")], output: nil, start: nil, end: nil),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)) else { return }
        let activity = ToolActivity.describe(run.parts[0])
        XCTAssertEqual(activity.label, "Reading pr-body.md")
        XCTAssertEqual(activity.status, .running)
        XCTAssertNil(ToolActivity.durationSeconds(of: run.parts[0]), "a timeless running call has no duration")
    }

    // MARK: - Subagent

    func testTaskPartMapsToATaskCallInTheRunAndToASubagentWithChildSession() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            taskPart("t1", "m1", childID: "ses_child", title: "unblock sweep", status: "running"),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)),
              let agent = ChatSubagentMapper.session(from: run.parts[0]) else {
            return XCTFail("expected a task call that maps to a subagent")
        }
        XCTAssertEqual(ToolActivity.describe(run.parts[0]).kind, .task)
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
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertTrue(blocks.isEmpty,
                      "an in-flight assistant message must not emit a canonical subagent row")
    }

    private func merge(
        tools: [LiveTool] = [],
        subagents: [StreamSubagentPayload] = [],
        context: TaskStatusContext = .empty,
        running: Bool = false,
        hasTailContent: Bool = false,
        to blocks: [TranscriptBlock] = []
    ) -> LiveActivityMerge {
        ChatTranscriptMapper.mergingLive(
            tools: tools, subagents: subagents, context: context,
            running: running, hasTailContent: hasTailContent, to: blocks)
    }

    func testLiveSubagentAppendsARunningTaskCall() {
        let result = merge(subagents: [runningPayload()])
        guard case .activity(let run)? = result.blocks.last, run.parts.count == 1,
              let agent = ChatSubagentMapper.session(from: run.parts[0]) else {
            return XCTFail("expected exactly one live task call")
        }
        XCTAssertEqual(agent.taskName, "unblock sweep")
        XCTAssertEqual(agent.childSessionId, "ses_child")
        XCTAssertEqual(agent.status, .running)
    }

    /// A finished subagent belongs to the canonical transcript.
    func testLiveSubagentCompletedIsNotAppendedWhenItIsReallyDone() {
        let done = StreamSubagentPayload(
            childSessionId: "ses_child", agent: nil, description: nil, prompt: nil,
            status: "completed", title: "sweep", output: "all good", truncated: nil,
            durationMs: nil, runningCount: nil, model: nil
        )
        XCTAssertTrue(merge(subagents: [done]).blocks.isEmpty,
                      "a finished subagent belongs to the canonical transcript, not the live feed")
    }

    /// Spec §5: a task whose tool call reads COMPLETED because the work was started
    /// in the background is kept while it is still running. It used to be dropped,
    /// so the card vanished mid-turn.
    func testLiveBackgroundTaskThatReadsCompletedIsKeptWhileItRuns() {
        let started = StreamSubagentPayload(
            childSessionId: "ses_child", agent: nil, description: nil, prompt: nil,
            status: "completed", title: "sweep", output: "<task id=\"1\" state=\"running\">started</task>",
            truncated: nil, durationMs: nil, runningCount: nil, model: nil
        )
        // The child is busy → kept.
        let busy = merge(subagents: [started], context: TaskStatusContext(childRunning: ["ses_child": true]))
        XCTAssertEqual(busy.blocks.count, 1, "a background task that is still running keeps its live row")
        // The child says idle → dropped (canonical owns the finished row).
        let idle = merge(subagents: [started], context: TaskStatusContext(childRunning: ["ses_child": false]))
        XCTAssertTrue(idle.blocks.isEmpty)
    }

    func testLiveSubagentDedupedAgainstCanonicalTaskCall() {
        let canonical = [message(id: "m1", role: "assistant", parts: [
            taskPart("t1", "m1", childID: "ses_child", title: "sweep", status: "running"),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: canonical)
        let result = merge(subagents: [runningPayload()], to: blocks)
        guard case .activity(let run)? = result.blocks.last else {
            return XCTFail("expected the canonical run")
        }
        XCTAssertEqual(run.parts.count, 1,
                       "a live card whose child the canonical transcript already names must not be appended")
    }

    func testLiveTaskToolRowIsSuppressed() {
        let task = LiveTool(idx: "t1", callID: "toolu_1", name: "task", presentationHint: "Find the skill", status: "running")
        XCTAssertTrue(merge(tools: [task]).blocks.isEmpty,
                      "the redundant task tool call must not render — the subagent frame owns the card")

        let bash = LiveTool(idx: "t2", callID: "toolu_2", name: "bash", presentationHint: "run tests", status: "running")
        guard case .activity(let run)? = merge(tools: [bash]).blocks.first else {
            return XCTFail("a non-task live tool must still append a call")
        }
        XCTAssertEqual(run.parts.count, 1)
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

    // MARK: - Run grouping (spec §1.1; the rules are the desktop's layoutTranscript)

    func testConsecutiveCallsAreOneRunNotARollupOfThreeOrMore() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)) else { return }
        XCTAssertEqual(run.parts.count, 2, "two calls are ONE run — the 3+ roll-up rule is gone")
        XCTAssertEqual(run.summary.label, "Read 2 files")
    }

    func testAMixedRunSummarisesByCategoryInFirstSeenOrder() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
            toolPart("t3", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)) else { return }
        XCTAssertEqual(run.summary.label, "Read 2 files, ran a command")
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
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
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
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
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
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertEqual(blocks.count, 3)
        guard case .activity(let a) = blocks[0], case .user = blocks[1], case .activity(let b) = blocks[2] else {
            return XCTFail("expected [.activity, .user, .activity], got \(blocks)")
        }
        XCTAssertNotEqual(a.id, b.id)
    }

    /// Todo-list writes never appear as tool calls.
    func testTodoWritesAreNotToolCalls() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "todowrite", status: "completed", input: [:]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
        ])]
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)) else { return }
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
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)) else { return }
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
        let first = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: msgs))
        let second = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: msgs))
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
        let before = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: one)).map(\.id)
        let after = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: two)).map(\.id)
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
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertEqual(blocks.count, 2, "expected prose + a run only, got \(blocks)")
        guard case .prose = blocks[0], case .activity = blocks[1] else {
            return XCTFail("expected [.prose, .activity], got \(blocks)")
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
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
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
        guard let run = onlyRun(ChatTranscriptMapper.blocks(from: msgs)) else { return }
        XCTAssertEqual(run.parts.count, 3)
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
            guard case .activity(let run) = block else { return [] }
            return run.parts.map(\.id)
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

    // MARK: - Live tools merged into the transcript (BET-823, spec §1)

    func testLiveToolExtendsTheLastRun() {
        let canonical = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: canonical)
        let live = [LiveTool(idx: "t2", callID: "toolu_2", name: "read", presentationHint: "a.ts", status: "running")]
        let merged = merge(tools: live, to: blocks)
        guard merged.blocks.count == 1, case .activity(let run) = merged.blocks[0], run.parts.count == 2 else {
            return XCTFail("expected both calls in one run")
        }
        XCTAssertEqual(run.id, "t1", "extending a run keeps its id")
        XCTAssertEqual(ToolActivity.describe(run.parts[0]).status, .completed)
        let liveActivity = ToolActivity.describe(run.parts[1])
        XCTAssertEqual(liveActivity.status, .running)
        XCTAssertEqual(liveActivity.label, "Reading a.ts")
    }

    func testLiveToolSkipsWhenCanonicalCounterpartExists() {
        // A live tool whose part id / callID the transcript already owns must not
        // be appended a second time — the canonical call takes over in place.
        let canonical = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: canonical)
        let live = [LiveTool(idx: "t1", callID: "t1", name: "bash", presentationHint: nil, status: "running")]
        let merged = merge(tools: live, to: blocks)
        guard case .activity(let run)? = merged.blocks.first else {
            return XCTFail("expected a run")
        }
        XCTAssertEqual(run.parts.count, 1, "the canonical call owns the row; no duplicate live call")
    }

    func testLiveToolCreatesARunWhenNoneExists() {
        let live = [LiveTool(idx: "t1", callID: "toolu_1", name: "bash", presentationHint: nil, status: "running")]
        let merged = merge(tools: live)
        guard case .activity(let run)? = merged.blocks.last else {
            return XCTFail("expected a run to be created at the tail")
        }
        XCTAssertEqual(run.id, "t1")
        XCTAssertEqual(run.parts.count, 1)
    }

    func testMergingLiveIsANoOpWhenNothingToAppend() {
        XCTAssertTrue(merge().blocks.isEmpty)
        XCTAssertNil(merge().trailing)
    }

    /// While a turn runs, the run at the very tail goes to the working line.
    func testWhileRunningTheTailRunIsWithheldAsTrailing() {
        let canonical = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: canonical)
        let running = merge(running: true, to: blocks)
        XCTAssertTrue(running.blocks.isEmpty, "the tail run is not a row while the turn runs")
        XCTAssertEqual(running.trailing?.id, "t1")

        let idle = merge(running: false, to: blocks)
        XCTAssertEqual(idle.blocks.count, 1, "once the turn ends the same run is an ordinary row")
        XCTAssertNil(idle.trailing)
    }

    /// Prose after the run means it is no longer at the tail: it stays inline, and
    /// live calls open a NEW run after the prose.
    func testRunFollowedByLiveProseStaysInlineAndLiveCallsOpenANewRun() {
        let canonical = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: canonical)
        let live = [LiveTool(idx: "t9", callID: "toolu_9", name: "read", presentationHint: "z.ts", status: "running")]
        let merged = merge(tools: live, running: true, hasTailContent: true, to: blocks)
        XCTAssertEqual(merged.blocks.count, 1, "the earlier run stays an inline row")
        XCTAssertEqual(merged.trailing?.id, "t9", "the live call opens its own trailing run")
        XCTAssertEqual(merged.trailing?.parts.count, 1)
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
        let blocks: [TranscriptBlock] = [.activity(ToolRun(id: "t1", parts: [part]))]

        let busy = ChatTranscriptMapper.resolvingTaskStatuses(
            blocks, context: TaskStatusContext(childRunning: ["ses_child": true]))
        guard case .activity(let runningRun) = busy[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(ToolActivity.describe(runningRun.parts[0]).status, .running)
        XCTAssertEqual(runningRun.summary.tone, .running)

        let idle = ChatTranscriptMapper.resolvingTaskStatuses(
            blocks, context: TaskStatusContext(childRunning: ["ses_child": false]))
        guard case .activity(let doneRun) = idle[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(ToolActivity.describe(doneRun.parts[0]).status, .completed,
                       "the row is upgraded to done once the child reports idle")
    }
}
