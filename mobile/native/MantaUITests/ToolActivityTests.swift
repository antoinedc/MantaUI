import XCTest
@testable import MantaUI

// Tool activity (WS11 D11): what the phone still owns of a tool call — detail disclosure, duration, task / delegate STATUS,
// run placement (by the box's run ids), the working-line assembly, and the todo card. The wording and the run rules are the
// BOX's (src/server/transcriptRuns.test.mjs); there is no parity fixture any more.

// MARK: - Shared builders

private func jstr(_ s: String) -> JSONValue { .string(s) }
private func jobj(_ d: [String: JSONValue]) -> JSONValue { .object(d) }

private func tool(
    _ id: String, _ name: String, status: String = "completed",
    input: [String: JSONValue] = [:], title: String? = nil, output: String? = nil,
    metadata: [String: JSONValue] = [:], error: String? = nil,
    start: Double? = nil, end: Double? = nil
) -> OpencodePart {
    var state: [String: JSONValue] = ["status": jstr(status), "input": jobj(input)]
    if let title { state["title"] = jstr(title) }
    if let output { state["output"] = jstr(output) }
    if let error { state["error"] = jstr(error) }
    if !metadata.isEmpty { state["metadata"] = jobj(metadata) }
    if let start {
        var time: [String: JSONValue] = ["start": .number(start)]
        if let end { time["end"] = .number(end) }
        state["time"] = jobj(time)
    }
    return OpencodePart(type: "tool", id: id, messageID: "m", extra: ["tool": jstr(name), "state": jobj(state)])
}

private func text(_ id: String, _ t: String) -> OpencodePart {
    OpencodePart(type: "text", id: id, messageID: "m", text: t)
}

private func runSummary(_ label: String = "Read a file", calls: Int = 1, failed: Int = 0, tone: GroupTone = .ok,
                        live: TranscriptLiveActivity? = nil) -> TranscriptRunSummary {
    TranscriptRunSummary(label: label, calls: calls, failed: failed, tone: tone, live: live)
}

/// A tool part stamped the way the box stamps it: its run (and segment) and its wording.
private func viewed(_ part: OpencodePart, run: String, segment: String? = nil, gen: Int? = nil, label: String = "Read x") -> OpencodePart {
    var copy = part
    copy.extra["view"] = TranscriptPartView.extra(
        activity: TranscriptActivityView(kind: .read, status: ToolActivity.status(of: part), label: label, target: "x", counted: true),
        runId: run, segmentId: segment, gen: gen)
    return copy
}

private func runView(_ id: String, _ label: String, owner: String = "a1", seq: Int = 1, segments: [TranscriptRunSegment] = []) -> TranscriptRunView {
    TranscriptRunView(id: id, ownerMessageId: owner, rev: TranscriptRunRev(epoch: "E1", gen: 1, seq: seq),
                      summary: runSummary(label), segments: segments)
}

private func message(_ id: String, _ role: String, _ parts: [OpencodePart]) -> OpencodeMessage {
    OpencodeMessage(
        info: OpencodeMessageInfo(id: id, sessionID: "s", role: OpencodeRole(rawValue: role),
                                  time: OpencodeTime(created: 1, completed: 2), modelID: nil, providerID: nil),
        parts: parts)
}

// MARK: - Status, durations, detail, disclosure, working line

final class ToolActivityTests: XCTestCase {

    func testStatusNormalisationMatchesDesktop() {
        XCTAssertEqual(ActivityStatus.normalize("completed"), .completed)
        XCTAssertEqual(ActivityStatus.normalize("error"), .error)
        XCTAssertEqual(ActivityStatus.normalize("running"), .running)
        XCTAssertEqual(ActivityStatus.normalize("pending"), .pending)
        XCTAssertEqual(ActivityStatus.normalize("denied"), .pending, "an unknown status is pending, as on desktop")
        XCTAssertEqual(ActivityStatus.normalize(nil), .pending)
    }

    func testDurationAndTotalDuration() {
        let a = tool("a", "read", start: 1000, end: 1400)
        let b = tool("b", "read", start: 1500, end: 3000)
        XCTAssertEqual(ToolActivity.durationSeconds(of: a) ?? -1, 0.4, accuracy: 0.0001)
        XCTAssertNil(ToolActivity.durationSeconds(of: tool("c", "read", start: 1000)), "no end yet")
        XCTAssertEqual(ToolRun(id: "a", parts: [a, b], view: runSummary()).totalDurationSeconds ?? -1, 2.0, accuracy: 0.0001)
        XCTAssertNil(ToolRun(id: "c", parts: [tool("c", "read")], view: runSummary()).totalDurationSeconds)
    }

    // MARK: Detail (what a tapped call row reveals)

    func testBashDetailIsTheCommandAndOutput() {
        let d = ToolActivity.detail(of: tool("a", "bash", input: ["command": jstr("npm test")], output: "ok\n"))
        XCTAssertEqual(d.command, "npm test")
        XCTAssertEqual(d.output, "ok\n")
        XCTAssertNil(d.error)
    }

    func testRunningBashDetailReadsTheLiveOutputFromMetadata() {
        let d = ToolActivity.detail(of: tool("a", "bash", status: "running", input: ["command": jstr("npm test")],
                                             metadata: ["output": jstr("tailing…")]))
        XCTAssertEqual(d.output, "tailing…")
    }

    func testEditDetailIsThePathAndTheDiff() {
        let withDiff = ToolActivity.detail(of: tool("a", "edit", input: ["filePath": jstr("/r/A.swift")],
                                                    metadata: ["diff": jstr("@@ -1 +1 @@\n-a\n+b")]))
        XCTAssertEqual(withDiff.path, "/r/A.swift")
        XCTAssertEqual(withDiff.diff, "@@ -1 +1 @@\n-a\n+b")

        let viaFilediff = ToolActivity.detail(of: tool("a", "edit", input: ["filePath": jstr("/r/A.swift")],
                                                       metadata: ["filediff": jobj(["patch": jstr("PATCH")])]))
        XCTAssertEqual(viaFilediff.diff, "PATCH")

        XCTAssertNil(ToolActivity.detail(of: tool("a", "edit", input: ["filePath": jstr("/r/A.swift")])).diff,
                     "a diff is shown only when the tool recorded one")
    }

    func testReadDetailIsPathAndTheOtherArguments() {
        let d = ToolActivity.detail(of: tool("a", "read", input: ["filePath": jstr("/r/A.swift"), "offset": .number(10), "limit": .number(50)],
                                             output: "contents"))
        XCTAssertEqual(d.path, "/r/A.swift")
        XCTAssertEqual(d.arguments, "limit: 50\noffset: 10", "arguments are sorted by key, numbers print as integers")
        XCTAssertEqual(d.output, "contents")
    }

    func testGrepDetailListsItsArguments() {
        let d = ToolActivity.detail(of: tool("a", "grep", input: ["pattern": jstr("TODO"), "include": jstr("*.swift")]))
        XCTAssertEqual(d.arguments, "include: *.swift\npattern: TODO")
    }

    func testAnErroredCallCarriesItsErrorText() {
        let d = ToolActivity.detail(of: tool("a", "bash", status: "error", input: ["command": jstr("false")], error: "exit 1"))
        XCTAssertEqual(d.error, "exit 1")
        XCTAssertFalse(d.isEmpty)
    }

    func testACallWithNothingToShowHasAnEmptyDetail() {
        XCTAssertTrue(ToolActivity.detail(of: tool("a", "question")).isEmpty,
                      "an empty detail means the row is not expandable (no dead tap)")
    }

    // MARK: Disclosure

    func testASingleCallRunOpensExpanded() {
        XCTAssertTrue(ActivityDisclosure.expanded(callCount: 1, status: .completed, isTool: true, userToggled: nil))
        XCTAssertFalse(ActivityDisclosure.expanded(callCount: 2, status: .completed, isTool: true, userToggled: nil))
        XCTAssertFalse(ActivityDisclosure.expanded(callCount: 1, status: .completed, isTool: false, userToggled: nil),
                       "a patch is not a call")
    }

    func testAFailedCallStartsExpandedAndUserIntentAlwaysWins() {
        XCTAssertTrue(ActivityDisclosure.expanded(callCount: 5, status: .error, isTool: true, userToggled: nil))
        XCTAssertFalse(ActivityDisclosure.expanded(callCount: 5, status: .error, isTool: true, userToggled: false))
        XCTAssertTrue(ActivityDisclosure.expanded(callCount: 5, status: .completed, isTool: true, userToggled: true))
        XCTAssertFalse(ActivityDisclosure.expanded(callCount: 1, status: .completed, isTool: true, userToggled: false))
    }

    // MARK: Working line (spec §1.4) — the summary is the box's; only the assembly is the phone's

    func testWorkingLineWhileAToolRuns() {
        let summary = TranscriptRunSummary(label: "Read 2 files", calls: 2, failed: 0, tone: .running,
                                           live: TranscriptLiveActivity(kind: .read, label: "Reading ChatScreen.swift"))
        XCTAssertEqual(summary.workingLineHeadline(verb: "Pondering"), "Reading ChatScreen.swift…")
        XCTAssertEqual(summary.workingLineMeta(elapsed: "12s"), "· 2 tools · 12s")
    }

    func testWorkingLineWithOneRunningToolDoesNotCountToolsOfOne() {
        let summary = TranscriptRunSummary(label: "Read a file", calls: 1, failed: 0, tone: .running,
                                           live: TranscriptLiveActivity(kind: .read, label: "Reading a.ts"))
        XCTAssertEqual(summary.workingLineMeta(elapsed: "3s"), "· 3s")
    }

    func testWorkingLineBetweenTools() {
        let summary = TranscriptRunSummary(label: "Read a file, ran a command", calls: 2, failed: 0, tone: .ok, live: nil)
        XCTAssertEqual(summary.workingLineHeadline(verb: "Pondering"), "Pondering…")
        XCTAssertEqual(summary.workingLineMeta(elapsed: "12s"), "· Read a file, ran a command · 12s")
        XCTAssertEqual(summary.workingLineMeta(elapsed: nil), "· Read a file, ran a command",
                       "an unknown turn start shows no timer rather than one restarting from zero")
    }

    func testARunSummaryIsRunningWhenTheBoxSaysSo() {
        XCTAssertTrue(runSummary(tone: .running).running)
        XCTAssertFalse(runSummary(tone: .warn).running)
    }
}

// MARK: - Layout by the box's run ids

final class ToolActivityLayoutTests: XCTestCase {

    private func asst(_ id: String, _ parts: [OpencodePart], view: TranscriptMessageView? = nil) -> OpencodeMessage {
        var m = message(id, "assistant", parts)
        m.view = view
        return m
    }

    private func runs(_ blocks: [ToolLayoutBlock]?) -> [ToolRun] {
        (blocks ?? []).compactMap { if case .tools(let r) = $0 { return r } else { return nil } }
    }

    func testARunSpansMessagesAndIsDrawnOnceAtItsFirstMessageWithTheBoxsSummary() {
        let layout = ToolActivity.layout(
            messages: [
                asst("a1", [viewed(tool("t1", "read"), run: "t1")]),
                asst("a2", [viewed(tool("t2", "read"), run: "t1")]),
            ],
            showThinking: false,
            runs: ["t1": runView("t1", "Read 2 files")]
        )
        let first = runs(layout.blocksByMessage["a1"])
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(first[0].id, "t1", "the run's id is its first part's id")
        XCTAssertEqual(first[0].parts.map(\.id), ["t1", "t2"])
        XCTAssertEqual(first[0].view.label, "Read 2 files", "the summary is the box's, never recomputed")
        XCTAssertEqual(layout.blocksByMessage["a2"]?.count, 0, "an absorbed message draws nothing")
    }

    func testAPartWithNoRunIdJoinsOneNeutralLinePerMessageAndIsNeverDropped() {
        let layout = ToolActivity.layout(
            messages: [asst("a1", [tool("t1", "read"), tool("t2", "bash")])], showThinking: false)
        let line = runs(layout.blocksByMessage["a1"])
        XCTAssertEqual(line.count, 1)
        XCTAssertTrue(line[0].isFallback)
        XCTAssertEqual(line[0].id, "tools:a1")
        XCTAssertEqual(line[0].view.label, "Tool activity")
        XCTAssertEqual(line[0].parts.map(\.id), ["t1", "t2"])
    }

    func testTextBetweenCallsDoesNotChangeRunMembershipTheBoxDecidesIt() {
        let layout = ToolActivity.layout(
            messages: [asst("a1", [
                viewed(tool("t1", "read"), run: "t1"), text("x1", "Found it."), viewed(tool("t2", "read"), run: "t2"),
            ])],
            showThinking: false,
            runs: ["t1": runView("t1", "Read a file"), "t2": runView("t2", "Read a file")]
        )
        let kinds = (layout.blocksByMessage["a1"] ?? []).map { block -> String in
            switch block { case .tools(let r): return "run:" + r.id; case .part(let p): return "part:" + p.id }
        }
        XCTAssertEqual(kinds, ["run:t1", "part:x1", "run:t2"])
    }

    func testWhitespaceOnlyTextDrawsNothing() {
        let layout = ToolActivity.layout(
            messages: [asst("a1", [viewed(tool("t1", "read"), run: "t1"), text("x1", "\n")])], showThinking: false)
        XCTAssertEqual(layout.blocksByMessage["a1"]?.count, 1)
    }

    func testReasoningShownDrawsOneBlockPerSegmentHiddenCollapsesThem() {
        let split = [
            TranscriptRunSegment(id: "t1", summary: runSummary("Read a file")),
            TranscriptRunSegment(id: "t2", summary: runSummary("Read a file")),
        ]
        let messages = [
            asst("a1", [viewed(tool("t1", "read"), run: "t1", segment: "t1")]),
            asst("a2", [
                OpencodePart(type: "reasoning", id: "r1", messageID: "a2", text: "thinking"),
                viewed(tool("t2", "read"), run: "t1", segment: "t2"),
            ]),
        ]
        let store = ["t1": runView("t1", "Read 2 files", segments: split)]
        let hidden = ToolActivity.layout(messages: messages, showThinking: false, runs: store)
        XCTAssertEqual(runs(hidden.blocksByMessage["a1"]).map(\.id), ["t1"])
        XCTAssertEqual(runs(hidden.blocksByMessage["a1"])[0].parts.count, 2)
        XCTAssertEqual(runs(hidden.blocksByMessage["a1"])[0].view.label, "Read 2 files")

        let shown = ToolActivity.layout(messages: messages, showThinking: true, runs: store)
        XCTAssertEqual(runs(shown.blocksByMessage["a1"]).map(\.id), ["t1"], "the first segment keeps the run's id")
        XCTAssertEqual(runs(shown.blocksByMessage["a2"]).map(\.id), ["t2"])
        XCTAssertEqual(runs(shown.blocksByMessage["a2"])[0].runID, "t1")
        XCTAssertEqual(runs(shown.blocksByMessage["a2"])[0].view.label, "Read a file", "the segment's own summary")
    }

    func testARunWhoseOwnerIsOutsideTheWindowIsDrawnAtTheFirstMessageThatHasAPartOfIt() {
        let layout = ToolActivity.layout(
            messages: [asst("a6", [viewed(tool("t6", "read"), run: "t1")]), asst("a7", [viewed(tool("t7", "read"), run: "t1")])],
            showThinking: false,
            runs: ["t1": runView("t1", "Read 8 files", owner: "a1")]
        )
        let block = runs(layout.blocksByMessage["a6"])
        XCTAssertEqual(block.count, 1)
        XCTAssertEqual(block[0].id, "t1", "the TRUE id, not the window's first part")
        XCTAssertEqual(layout.blocksByMessage["a7"]?.count, 0)
    }

    func testAMembershipOlderThanMinGenIsIgnoredForLayout() {
        let layout = ToolActivity.layout(
            messages: [asst("a1", [viewed(tool("t1", "read"), run: "t1", gen: 1)])], showThinking: false, minGen: 2)
        XCTAssertTrue(runs(layout.blocksByMessage["a1"]).allSatisfy(\.isFallback), "a retired run id can never be resurrected")
    }

    func testTheSummaryFallsBackToTheRunViewAMessageCarries() {
        let carried = TranscriptMessageView(runs: [.view(runView("t1", "Read a file"))])
        let layout = ToolActivity.layout(
            messages: [asst("a1", [viewed(tool("t1", "read"), run: "t1")], view: carried)], showThinking: false)
        XCTAssertEqual(runs(layout.blocksByMessage["a1"])[0].view.label, "Read a file")
    }

    func testAHandoffCallStandsAloneAsAPart() {
        let handoff = tool("h1", "handoff")
        let layout = ToolActivity.layout(messages: [asst("a1", [handoff])], showThinking: false)
        XCTAssertEqual(layout.blocksByMessage["a1"], [.part(handoff)])
    }

    func testRunUpsertingSkipsWhatItAlreadyOwns() {
        let run = ToolRun(id: "t1", parts: [tool("t1", "read")], view: runSummary())
        let merged = run.upserting([tool("t1", "read"), tool("t2", "bash")])  // t1 is a duplicate part id
        XCTAssertEqual(merged.parts.map(\.id), ["t1", "t2"])
        XCTAssertEqual(merged.id, "t1", "extending a run never changes its id")
    }

    func testRunUpsertingDedupesByCallIDAndByChildSession() {
        let canonical = OpencodePart(type: "tool", id: "t1", messageID: "m", extra: [
            "tool": jstr("task"), "callID": jstr("c1"),
            "state": jobj(["status": jstr("running"), "metadata": jobj(["sessionId": jstr("child")])]),
        ])
        let liveSameCall = OpencodePart(type: "tool", id: "live1", messageID: "m", extra: ["tool": jstr("task"), "callID": jstr("c1"), "state": jobj([:])])
        let liveSameChild = ToolActivity.makeToolPart(id: "live-task-child", tool: "task", status: "running", metadata: ["sessionId": jstr("child")])
        let merged = ToolRun(id: "t1", parts: [canonical], view: runSummary()).upserting([liveSameCall, liveSameChild])
        XCTAssertEqual(merged.parts.count, 1)
    }
}

// MARK: - Task status resolution (spec §5)

final class TaskStatusResolverTests: XCTestCase {

    private let marker = "<task id=\"abc\" state=\"running\">started in background</task>"

    private func resolve(
        _ toolStatus: String, child: String? = "c", output: String? = nil,
        childRunning: [String: Bool] = [:], jobs: [String: String] = [:]
    ) -> TaskRunStatus {
        TaskStatusResolver.resolve(
            toolStatus: toolStatus, childSessionID: child, output: output,
            context: TaskStatusContext(childRunning: childRunning, jobStatus: jobs))
    }

    // Rule 1
    func testAnErroredCallIsFailedWhateverElseIsTrue() {
        XCTAssertEqual(resolve("error"), .failed)
        XCTAssertEqual(resolve("error", childRunning: ["c": true], jobs: ["c": "running"]), .failed,
                       "rule 1 comes first: an error is failed even if the child is busy")
    }

    // Rule 2
    func testABusyChildIsRunningEvenWhenTheCallReadsCompleted() {
        XCTAssertEqual(resolve("completed", childRunning: ["c": true]), .running)
    }

    // Rule 3
    func testARunningOrPausedJobRecordIsRunning() {
        XCTAssertEqual(resolve("completed", jobs: ["c": "running"]), .running)
        XCTAssertEqual(resolve("completed", jobs: ["c": "paused"]), .running)
        XCTAssertEqual(resolve("completed", jobs: ["c": "done"]), .done)
        XCTAssertEqual(resolve("completed", jobs: ["c": "failed"]), .done)
    }

    // Rule 4
    func testPendingAndRunningCallsAreRunning() {
        XCTAssertEqual(resolve("pending"), .running)
        XCTAssertEqual(resolve("running"), .running)
        XCTAssertEqual(resolve("running", childRunning: ["c": false]), .running,
                       "rule 4 applies before any 'idle' evidence: the refetch will correct the call's own status")
    }

    // Rule 5
    func testACompletedBackgroundTaskIsRunningUntilTheChildIsIdleOrTheJobIsDone() {
        XCTAssertEqual(resolve("completed", output: marker), .backgroundRunning, "nothing says otherwise yet")
        XCTAssertEqual(resolve("completed", output: marker, childRunning: [:], jobs: [:]), .backgroundRunning)
        XCTAssertEqual(resolve("completed", output: marker, childRunning: ["c": false]), .done, "idle upgrades it")
        XCTAssertEqual(resolve("completed", output: marker, jobs: ["c": "done"]), .done, "a finished job upgrades it")
        XCTAssertTrue(resolve("completed", output: marker).isRunning)
    }

    func testOnlyTheBackgroundMarkerCountsAsABackgroundTask() {
        XCTAssertEqual(resolve("completed", output: "all done"), .done)
        XCTAssertEqual(resolve("completed", output: "<task id=\"1\" state=\"completed\">x</task>"), .done)
        XCTAssertEqual(resolve("completed", output: "prefix <task state=\"running\">"), .done, "the output must START with <task")
        XCTAssertEqual(resolve("completed", output: nil), .done)
        XCTAssertTrue(TaskStatusResolver.isBackgroundTaskOutput("  \n<task id=\"1\" state=\"running\">"))
    }

    // Rule 6
    func testACompletedCallIsDone() {
        XCTAssertEqual(resolve("completed"), .done)
        XCTAssertEqual(resolve("completed", child: nil), .done)
    }

    func testStatusWireMapping() {
        XCTAssertEqual(TaskRunStatus.running.wireStatus, "running")
        XCTAssertEqual(TaskRunStatus.backgroundRunning.wireStatus, "running")
        XCTAssertEqual(TaskRunStatus.done.wireStatus, "completed")
        XCTAssertEqual(TaskRunStatus.failed.wireStatus, "error")
    }

    private func taskPart(status: String, output: String? = nil) -> OpencodePart {
        tool("t1", "task", status: status, input: ["description": jstr("sweep")], output: output,
             metadata: ["sessionId": jstr("c")])
    }

    func testApplyingRewritesOnlyWhenTheResolvedStatusDiffers() {
        let ctx = TaskStatusContext(childRunning: ["c": true])
        let started = taskPart(status: "completed", output: marker)
        XCTAssertEqual(ToolActivity.status(of: TaskStatusResolver.applying(ctx, to: started)), .running)

        let pending = taskPart(status: "pending")
        XCTAssertEqual(TaskStatusResolver.applying(ctx, to: pending), pending,
                       "pending already reads as unfinished: nothing to rewrite")

        let done = taskPart(status: "completed")
        XCTAssertEqual(TaskStatusResolver.applying(.empty, to: done), done)

        let bash = tool("b", "bash", status: "completed")
        XCTAssertEqual(TaskStatusResolver.applying(ctx, to: bash), bash, "non-task parts are untouched")
    }

    func testResolvingARunUpgradesItsBackgroundTaskOnceTheChildIsIdle() {
        let run = ToolRun(id: "t1", parts: [taskPart(status: "completed", output: marker)], view: runSummary())
        XCTAssertEqual(ToolActivity.status(of: run.resolvingTasks(TaskStatusContext(childRunning: [:])).parts[0]), .running)
        XCTAssertEqual(ToolActivity.status(of: run.resolvingTasks(TaskStatusContext(childRunning: ["c": false])).parts[0]), .completed)
        XCTAssertEqual(run.resolvingTasks(TaskStatusContext(childRunning: [:])).view, run.view,
                       "the run's summary is the box's; resolving a task's status never rewrites it")
    }

    func testChildSessionIDsAreCollectedFromTaskParts() {
        let ids = TaskStatusResolver.childSessionIDs(in: [
            message("a1", "assistant", [taskPart(status: "completed"), tool("t2", "bash")]),
        ])
        XCTAssertEqual(ids, ["c"])
    }
}

// MARK: - Delegate calls (job linking; the wording is the box's)

final class DelegateCallTests: XCTestCase {

    private let started = "Started background job \"you-are-the-ship-gate\" (id 198262c2). It runs in its own session and reports back."

    private func delegate(
        status: String = "completed", output: String? = nil, input: [String: JSONValue] = [:],
        name: String = "delegate_delegate", metadataOutput: String? = nil
    ) -> OpencodePart {
        tool("d1", name, status: status, input: input, output: output,
             metadata: metadataOutput.map { ["output": jstr($0)] } ?? [:])
    }

    func testDelegateToolNames() {
        XCTAssertTrue(TaskStatusResolver.isDelegateToolName("delegate_delegate"))
        XCTAssertTrue(TaskStatusResolver.isDelegateToolName("delegate"))
        XCTAssertTrue(TaskStatusResolver.isDelegateToolName("mcp_delegate_delegate"))
        XCTAssertFalse(TaskStatusResolver.isDelegateToolName("delegate_list"))
        XCTAssertFalse(TaskStatusResolver.isDelegateToolName("delegate_stop"))
        XCTAssertFalse(TaskStatusResolver.isDelegateToolName("task"))
        XCTAssertTrue(TaskStatusResolver.isDelegateTool(delegate()))
        XCTAssertFalse(TaskStatusResolver.isDelegateTool(tool("b", "bash")))
    }

    func testJobIDParsing() {
        XCTAssertEqual(TaskStatusResolver.delegateJobID(fromOutput: started), "198262c2")
        XCTAssertEqual(TaskStatusResolver.delegateJobID(fromOutput: "x (id 0a1b) y"), "0a1b")
        // No match.
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: nil))
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: ""))
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: "Error: the cap of five jobs is reached"))
        // Malformed: empty, non-hex, uppercase, unclosed, wrong keyword.
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: "job (id )"))
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: "job (id xyz)"))
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: "job (id 198262C2)"))
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: "job (id 198262c2"))
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: "job id 198262c2"))
        XCTAssertNil(TaskStatusResolver.delegateJobID(fromOutput: "job (ID 198262c2)"))
    }

    func testARunningJobMakesTheFinishedCallReadRunning() {
        let part = delegate(output: started)
        for status in ["running", "paused", "Running"] {
            let ctx = TaskStatusContext(jobStatusByID: ["198262c2": status])
            let resolved = TaskStatusResolver.applying(ctx, to: part)
            XCTAssertEqual(ToolActivity.status(of: resolved), .running, status)
        }
        let run = ToolRun(id: "d1", parts: [part], view: runSummary())
        XCTAssertEqual(ToolActivity.status(of: run.resolvingTasks(TaskStatusContext(jobStatusByID: ["198262c2": "running"])).parts[0]), .running)
    }

    func testAJobThatIsDoneFailedOrUnknownLeavesTheCallAlone() {
        let part = delegate(output: started)
        for status in ["done", "failed", "stopped"] {
            let ctx = TaskStatusContext(jobStatusByID: ["198262c2": status])
            XCTAssertEqual(TaskStatusResolver.applying(ctx, to: part), part,
                           "a \(status) job is not a failed tool call — its status lives in the jobs sheet")
        }
        XCTAssertEqual(TaskStatusResolver.applying(TaskStatusContext(jobStatusByID: ["other": "running"]), to: part), part,
                       "an unknown job leaves the call as it is")
        XCTAssertEqual(TaskStatusResolver.applying(.empty, to: part), part)
        // Keyed by CHILD session, not job id, must not link.
        XCTAssertEqual(TaskStatusResolver.applying(TaskStatusContext(jobStatus: ["198262c2": "running"]), to: part), part)
    }

    func testAnErroredOrOutputlessCallIsNeverRewritten() {
        let ctx = TaskStatusContext(jobStatusByID: ["198262c2": "running"])
        let errored = delegate(status: "error", output: started)
        XCTAssertEqual(TaskStatusResolver.applying(ctx, to: errored), errored)
        let noOutput = delegate()
        XCTAssertEqual(TaskStatusResolver.applying(ctx, to: noOutput), noOutput)
        let list = tool("l", "delegate_list", output: started)
        XCTAssertEqual(TaskStatusResolver.applying(ctx, to: list), list)
    }

    /// A LIVE delegate part has no `state.output`: its final output rides the
    /// stdout tail (`state.metadata.output`).
    func testTheJobIDIsReadFromTheLiveTailToo() {
        let part = delegate(metadataOutput: started)
        let ctx = TaskStatusContext(jobStatusByID: ["198262c2": "running"])
        XCTAssertEqual(ToolActivity.status(of: TaskStatusResolver.applying(ctx, to: part)), .running)
    }
}

// MARK: - Todo card (spec §6)

final class TodoCardLogicTests: XCTestCase {

    private func item(_ content: String, _ status: String) -> StreamTodoItem {
        StreamTodoItem(id: nil, content: content, status: status)
    }

    func testProgressCountsTheWholeListAndCancelledAsSettled() {
        let p = TodoCardLogic.progress([
            item("a", "completed"), item("b", "cancelled"), item("c", "in_progress"),
            item("d", "pending"), item("e", "pending"), item("f", "pending"), item("g", "pending"),
        ])
        XCTAssertEqual(p.label, "2/7")
        XCTAssertEqual(p.total, 7)
        XCTAssertEqual(p.inProgress, 1)
        XCTAssertFalse(p.allSettled)
        XCTAssertEqual(p.settledPct, 2.0 / 7.0 * 100, accuracy: 0.0001)
    }

    func testProgressStatusIsCaseInsensitiveAndEmptyIsSafe() {
        XCTAssertEqual(TodoCardLogic.progress([item("a", "COMPLETED")]).label, "1/1")
        XCTAssertTrue(TodoCardLogic.progress([item("a", "COMPLETED")]).allSettled)
        let empty = TodoCardLogic.progress([])
        XCTAssertEqual(empty.label, "0/0")
        XCTAssertFalse(empty.allSettled)
        XCTAssertEqual(empty.settledPct, 0)
    }

    func testHeadlineIsTheCurrentItemElseTheNextPending() {
        XCTAssertEqual(TodoCardLogic.headline([item("a", "completed"), item("b", "pending"), item("c", "in_progress")])?.content, "c")
        XCTAssertEqual(TodoCardLogic.headline([item("a", "completed"), item("b", "pending"), item("c", "pending")])?.content, "b")
        XCTAssertNil(TodoCardLogic.headline([item("a", "completed"), item("b", "cancelled")]))
        XCTAssertNil(TodoCardLogic.headline([]))
    }

    func testAllTerminalNeedsANonEmptyAllSettledList() {
        XCTAssertTrue(TodoCardLogic.allTerminal([item("a", "completed"), item("b", "cancelled")]))
        XCTAssertFalse(TodoCardLogic.allTerminal([item("a", "completed"), item("b", "pending")]))
        XCTAssertFalse(TodoCardLogic.allTerminal([]))
    }

    private func payload(_ items: [StreamTodoItem]?) -> StreamTodosPayload {
        StreamTodosPayload(active: items, visible: nil, allTerminal: false, anyTerminal: false)
    }

    func testALiveListWinsOverTheTranscript() {
        let live = [item("live", "pending")]
        let transcript = [item("old", "completed")]
        XCTAssertEqual(TodoCardLogic.select(live: payload(live), transcript: transcript, dismissed: nil), live)
    }

    /// opencode fires `todo.updated` with an EMPTY list when the model clears it:
    /// that means "explicitly cleared", not "no data" — the transcript must not
    /// resurrect the old list.
    func testAnEmptyLiveListMeansClearedAndHidesTheCard() {
        XCTAssertNil(TodoCardLogic.select(live: payload([]), transcript: [item("old", "pending")], dismissed: nil))
        XCTAssertNil(TodoCardLogic.select(live: payload(nil), transcript: [item("old", "pending")], dismissed: nil))
    }

    func testWithNoLiveFrameTheTranscriptsLastTodoWriteIsUsed() {
        let transcript = [item("old", "pending")]
        XCTAssertEqual(TodoCardLogic.select(live: nil, transcript: transcript, dismissed: nil), transcript)
        XCTAssertNil(TodoCardLogic.select(live: nil, transcript: [], dismissed: nil))
        XCTAssertNil(TodoCardLogic.select(live: nil, transcript: nil, dismissed: nil))
    }

    func testADismissedListStaysHiddenUntilItChanges() {
        let list = [item("a", "completed"), item("b", "completed")]
        XCTAssertNil(TodoCardLogic.select(live: payload(list), transcript: nil, dismissed: list))
        let changed = [item("a", "completed"), item("b", "completed"), item("c", "pending")]
        XCTAssertEqual(TodoCardLogic.select(live: payload(changed), transcript: nil, dismissed: list), changed,
                       "the next todo update brings the card back")
        XCTAssertNil(TodoCardLogic.select(live: nil, transcript: list, dismissed: list),
                     "dismissal also covers a list recovered from the transcript")
    }

    func testFromTranscriptTakesTheMostRecentNonEmptyTodoWrite() {
        func todoWrite(_ id: String, _ todos: [(String, String)]) -> OpencodePart {
            let raw: [JSONValue] = todos.map { jobj(["content": jstr($0.0), "status": jstr($0.1)]) }
            return tool(id, "todowrite", input: ["todos": .array(raw)])
        }
        let messages = [
            message("a1", "assistant", [todoWrite("t1", [("first", "pending")])]),
            message("a2", "assistant", [todoWrite("t2", [("second", "in_progress"), ("third", "pending")]), todoWrite("t3", [])]),
        ]
        let items = TodoCardLogic.fromTranscript(messages)
        XCTAssertEqual(items?.map { $0.content ?? "" }, ["second", "third"],
                       "the latest NON-EMPTY write wins; an empty later write is skipped")
        XCTAssertNil(TodoCardLogic.fromTranscript([message("a1", "assistant", [tool("t", "bash")])]))
    }
}
