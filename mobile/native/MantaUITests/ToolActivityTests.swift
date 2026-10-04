import XCTest
@testable import MantaUI

// Tool activity (spec 2026-10-04-ios-activity-parity §1, §5, §6) — the PURE
// logic in ToolActivity.swift. Foundation-only on purpose, so this file also
// compiles in the Linux `swift test` view of the app.

// MARK: - Parity fixture (the desktop contract)

/// Asserts the Swift port against `src/shared/fixtures/tool-activity-cases.json`,
/// the same file `src/renderer/toolActivity.fixture.test.ts` asserts against
/// `toolActivity.ts`. If one client's wording changes without the fixture, a
/// suite goes red.
final class ToolActivityParityTests: XCTestCase {

    private struct DescribeExpect: Decodable, Equatable {
        var kind: String, status: String, running: String, done: String, failed: String, label: String
        var counted: Bool
    }
    private struct DescribeCase: Decodable {
        var name: String
        var part: OpencodePart
        var expect: DescribeExpect
    }
    private struct SummarizeExpect: Decodable, Equatable {
        var label: String
        var calls: Int
        var failed: Int
        var running: Bool
        var live: String?
    }
    private struct SummarizeCase: Decodable {
        var name: String
        var parts: [OpencodePart]
        var expect: SummarizeExpect
    }
    private struct LayoutExpect: Decodable, Equatable {
        var blocks: [String: [String]]
        var trailing: String?
    }
    private struct LayoutCase: Decodable {
        var name: String
        var running: Bool
        var showThinking: Bool
        var messages: [OpencodeMessage]
        var expect: LayoutExpect
    }
    private struct Fixture: Decodable {
        var describe: [DescribeCase]
        var summarize: [SummarizeCase]
        var layout: [LayoutCase]
    }

    /// The fixture is a test resource of the app's test bundle (project.yml); a
    /// bare `swift test` has no resource bundle, so fall back to the checkout the
    /// test was compiled from.
    private func loadFixture() throws -> Fixture {
        let data: Data
        if let url = Bundle(for: ToolActivityParityTests.self).url(forResource: "tool-activity-cases", withExtension: "json") {
            data = try Data(contentsOf: url)
        } else {
            var url = URL(fileURLWithPath: #filePath)
            for _ in 0..<4 { url.deleteLastPathComponent() }
            url.appendPathComponent("src/shared/fixtures/tool-activity-cases.json")
            data = try Data(contentsOf: url)
        }
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    func testFixtureIsBigEnoughToBeAContract() throws {
        let f = try loadFixture()
        XCTAssertGreaterThanOrEqual(f.describe.count + f.summarize.count, 25)
        XCTAssertGreaterThanOrEqual(f.layout.count, 6)
    }

    func testDescribeMatchesTheFixture() throws {
        for c in try loadFixture().describe {
            let a = ToolActivity.describe(c.part)
            let actual = DescribeExpect(
                kind: a.kind.rawValue, status: a.status.rawValue,
                running: a.running, done: a.done, failed: a.failed, label: a.label, counted: a.counted)
            XCTAssertEqual(actual, c.expect, c.name)
        }
    }

    func testSummaryMatchesTheFixture() throws {
        for c in try loadFixture().summarize {
            let s = ToolActivity.summarize(c.parts)
            let actual = SummarizeExpect(
                label: s.label, calls: s.calls, failed: s.failed, running: s.running, live: s.live?.running)
            XCTAssertEqual(actual, c.expect, c.name)
        }
    }

    func testRunLayoutMatchesTheFixture() throws {
        for c in try loadFixture().layout {
            let layout = ToolActivity.layout(messages: c.messages, running: c.running, showThinking: c.showThinking)
            var blocks: [String: [String]] = [:]
            for (id, bs) in layout.blocksByMessage {
                blocks[id] = bs.map { block in
                    switch block {
                    case .tools(let run): return "tools:" + run.parts.map(\.id).joined(separator: ",")
                    case .part(let part): return "part:" + part.id
                    }
                }
            }
            let actual = LayoutExpect(blocks: blocks, trailing: layout.trailing.map { $0.parts.map(\.id).joined(separator: ",") })
            XCTAssertEqual(actual, c.expect, c.name)
        }
    }
}

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

private func message(_ id: String, _ role: String, _ parts: [OpencodePart]) -> OpencodeMessage {
    OpencodeMessage(
        info: OpencodeMessageInfo(id: id, sessionID: "s", role: OpencodeRole(rawValue: role),
                                  time: OpencodeTime(created: 1, completed: 2), modelID: nil, providerID: nil),
        parts: parts)
}

// MARK: - Wording details beyond the fixture

final class ToolActivityWordingTests: XCTestCase {

    func testHostOfKeepsNonDefaultPortsAndLowercases() {
        XCTAssertEqual(ToolActivity.hostOf("https://Example.COM:8443/x"), "example.com:8443")
        XCTAssertEqual(ToolActivity.hostOf("http://example.com:80/x"), "example.com")
        XCTAssertEqual(ToolActivity.hostOf("not a url"), "not a url")
        XCTAssertEqual(ToolActivity.hostOf(""), "")
    }

    func testClipCountsUTF16LikeJS() {
        let sixtyOne = String(repeating: "a", count: 61)
        let clipped = ToolActivity.clip(sixtyOne, 60)
        XCTAssertEqual(clipped.utf16.count, 60)
        XCTAssertTrue(clipped.hasSuffix("…"))
        XCTAssertEqual(ToolActivity.clip(String(repeating: "a", count: 60), 60).utf16.count, 60)
        // Trailing whitespace before the ellipsis is trimmed (JS trimEnd).
        XCTAssertEqual(ToolActivity.clip("abcdefgh  ijkl", 11), "abcdefgh…")
    }

    func testStatusNormalisationMatchesDesktop() {
        XCTAssertEqual(ActivityStatus.normalize("completed"), .completed)
        XCTAssertEqual(ActivityStatus.normalize("error"), .error)
        XCTAssertEqual(ActivityStatus.normalize("running"), .running)
        XCTAssertEqual(ActivityStatus.normalize("pending"), .pending)
        XCTAssertEqual(ActivityStatus.normalize("denied"), .pending, "an unknown status is pending, as on desktop")
        XCTAssertEqual(ActivityStatus.normalize(nil), .pending)
    }

    func testGroupToneFollowsRunningThenFailedThenOk() {
        func tone(_ parts: [OpencodePart]) -> GroupTone { ToolActivity.summarize(parts).tone }
        XCTAssertEqual(tone([tool("a", "read", input: ["filePath": jstr("x")], title: nil)]), .ok)
        XCTAssertEqual(tone([tool("a", "read", status: "error")]), .warn)
        XCTAssertEqual(tone([tool("a", "read", status: "running"), tool("b", "read", status: "error")]), .running,
                       "a run that is still going is running even when an earlier call failed")
    }

    func testTargetIsTheFullPathCommandPatternOrUrl() {
        XCTAssertEqual(ToolActivity.target(of: tool("a", "read", input: ["filePath": jstr("/r/src/A.swift")])), "/r/src/A.swift")
        XCTAssertEqual(ToolActivity.target(of: tool("a", "bash", input: ["command": jstr("git status\ngit diff")])), "git status")
        XCTAssertEqual(ToolActivity.target(of: tool("a", "grep", input: ["pattern": jstr("TODO")])), "TODO")
        XCTAssertEqual(ToolActivity.target(of: tool("a", "webfetch", input: ["url": jstr("https://a.com/x")])), "https://a.com/x")
        XCTAssertEqual(ToolActivity.target(of: tool("a", "mystery", title: "A title")), "A title")
        XCTAssertEqual(ToolActivity.target(of: tool("a", "read")), "")
    }

    func testDurationAndTotalDuration() {
        let a = tool("a", "read", start: 1000, end: 1400)
        let b = tool("b", "read", start: 1500, end: 3000)
        XCTAssertEqual(ToolActivity.durationSeconds(of: a) ?? -1, 0.4, accuracy: 0.0001)
        XCTAssertNil(ToolActivity.durationSeconds(of: tool("c", "read", start: 1000)), "no end yet")
        XCTAssertEqual(ToolRun(id: "a", parts: [a, b]).totalDurationSeconds ?? -1, 2.0, accuracy: 0.0001)
        XCTAssertNil(ToolRun(id: "c", parts: [tool("c", "read")]).totalDurationSeconds)
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

    // MARK: Working line (spec §1.4)

    func testWorkingLineWhileAToolRuns() {
        let summary = ToolActivity.summarize([
            tool("a", "read", input: ["filePath": jstr("a.ts")]),
            tool("b", "read", status: "running", input: ["filePath": jstr("ChatScreen.swift")]),
        ])
        XCTAssertEqual(summary.workingLineHeadline(verb: "Pondering"), "Reading ChatScreen.swift…")
        XCTAssertEqual(summary.workingLineMeta(elapsed: "12s"), "· 2 tools · 12s")
    }

    func testWorkingLineWithOneRunningToolDoesNotCountToolsOfOne() {
        let summary = ToolActivity.summarize([tool("b", "read", status: "running", input: ["filePath": jstr("a.ts")])])
        XCTAssertEqual(summary.workingLineMeta(elapsed: "3s"), "· 3s")
    }

    func testWorkingLineBetweenTools() {
        let summary = ToolActivity.summarize([
            tool("a", "read", input: ["filePath": jstr("a.ts")]),
            tool("b", "bash", input: ["command": jstr("ls")]),
        ])
        XCTAssertEqual(summary.workingLineHeadline(verb: "Pondering"), "Pondering…")
        XCTAssertEqual(summary.workingLineMeta(elapsed: "12s"), "· Read a file, ran a command · 12s")
        XCTAssertEqual(summary.workingLineMeta(elapsed: nil), "· Read a file, ran a command",
                       "an unknown turn start shows no timer rather than one restarting from zero")
    }
}

// MARK: - Layout details beyond the fixture

final class ToolActivityLayoutTests: XCTestCase {

    /// DELIBERATE deviation from the desktop (documented in ToolActivity.swift):
    /// iOS draws nothing for a whitespace-only text part (BET-632), so it must not
    /// end a run the way desktop's would.
    func testWhitespaceOnlyTextIsTransparentToARun() {
        let layout = ToolActivity.layout(messages: [
            message("a1", "assistant", [tool("t1", "read"), text("x1", "\n"), tool("t2", "read")]),
        ], running: false, showThinking: false)
        guard case .tools(let run)? = layout.blocksByMessage["a1"]?.first else { return XCTFail("expected a run") }
        XCTAssertEqual(layout.blocksByMessage["a1"]?.count, 1)
        XCTAssertEqual(run.parts.map(\.id), ["t1", "t2"])
    }

    func testAUserMessageWithOnlyBlankTextDoesNotEndARun() {
        let layout = ToolActivity.layout(messages: [
            message("a1", "assistant", [tool("t1", "read")]),
            message("u1", "user", [text("x1", "  \n")]),
            message("a2", "assistant", [tool("t2", "read")]),
        ], running: false, showThinking: false)
        XCTAssertEqual(layout.blocksByMessage["a2"]?.count, 0, "a blank user message draws no band, so the run continues")
    }

    func testTrailingRunKeepsTheOwningMessageIdAndDropsItsPlaceholder() {
        let layout = ToolActivity.layout(messages: [
            message("a1", "assistant", [text("x1", "Looking."), tool("t1", "read")]),
        ], running: true, showThinking: false)
        XCTAssertEqual(layout.trailing?.id, "t1")
        XCTAssertEqual(layout.blocksByMessage["a1"]?.count, 1, "only the text remains; the run moved to the working line")
    }

    func testRunAppendingSkipsWhatItAlreadyOwns() {
        let run = ToolRun(id: "t1", parts: [tool("t1", "read")])
        let merged = run.appending([tool("t1", "read"), tool("t2", "bash")])  // t1 is a duplicate part id
        XCTAssertEqual(merged.parts.map(\.id), ["t1", "t2"])
        XCTAssertEqual(merged.id, "t1", "extending a run never changes its id")
    }

    func testRunAppendingDedupesByCallIDAndByChildSession() {
        let canonical = OpencodePart(type: "tool", id: "t1", messageID: "m", extra: [
            "tool": jstr("task"), "callID": jstr("c1"),
            "state": jobj(["status": jstr("running"), "metadata": jobj(["sessionId": jstr("child")])]),
        ])
        let liveSameCall = OpencodePart(type: "tool", id: "live1", messageID: "m", extra: ["tool": jstr("task"), "callID": jstr("c1"), "state": jobj([:])])
        let liveSameChild = ToolActivity.makeToolPart(id: "live-task-child", tool: "task", status: "running", metadata: ["sessionId": jstr("child")])
        let merged = ToolRun(id: "t1", parts: [canonical]).appending([liveSameCall, liveSameChild])
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
        XCTAssertEqual(ToolActivity.describe(TaskStatusResolver.applying(ctx, to: started)).status, .running)

        let pending = taskPart(status: "pending")
        XCTAssertEqual(TaskStatusResolver.applying(ctx, to: pending), pending,
                       "pending already reads as unfinished: nothing to rewrite")

        let done = taskPart(status: "completed")
        XCTAssertEqual(TaskStatusResolver.applying(.empty, to: done), done)

        let bash = tool("b", "bash", status: "completed")
        XCTAssertEqual(TaskStatusResolver.applying(ctx, to: bash), bash, "non-task parts are untouched")
    }

    func testResolvingARunUpgradesItsBackgroundTaskOnceTheChildIsIdle() {
        let run = ToolRun(id: "t1", parts: [taskPart(status: "completed", output: marker)])
        XCTAssertEqual(run.resolvingTasks(TaskStatusContext(childRunning: [:])).summary.tone, .running)
        XCTAssertEqual(run.resolvingTasks(TaskStatusContext(childRunning: ["c": false])).summary.tone, .ok)
    }

    func testChildSessionIDsAreCollectedFromTaskParts() {
        let ids = TaskStatusResolver.childSessionIDs(in: [
            message("a1", "assistant", [taskPart(status: "completed"), tool("t2", "bash")]),
        ])
        XCTAssertEqual(ids, ["c"])
    }
}

// MARK: - Delegate calls (iOS-only wording + job linking)

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

    func testWordingReadsAsABackgroundJobNotAsDelegateDelegate() {
        let done = ToolActivity.describe(delegate(output: started))
        XCTAssertEqual(done.kind, .delegate)
        XCTAssertEqual(done.label, "Started background job you-are-the-ship-gate")
        XCTAssertEqual(done.running, "Running background job you-are-the-ship-gate")
        XCTAssertEqual(done.failed, "Failed to start background job you-are-the-ship-gate")

        let failed = ToolActivity.describe(delegate(status: "error", input: ["prompt": jstr("Fix the build")]))
        XCTAssertEqual(failed.label, "Failed to start background job Fix the build")

        XCTAssertEqual(ToolActivity.describe(delegate(status: "running", name: "delegate")).label,
                       "Running background job")
    }

    func testNameFallsBackToTheInputAndIsClipped() {
        let long = String(repeating: "a", count: 90)
        let byDescription = delegate(input: ["description": jstr("  sweep the board \nsecond line"), "prompt": jstr("ignored")])
        XCTAssertEqual(TaskStatusResolver.delegateJobName(of: byDescription), "sweep the board")
        let byPrompt = delegate(input: ["prompt": jstr("\n\nFirst real line\nmore")])
        XCTAssertEqual(TaskStatusResolver.delegateJobName(of: byPrompt), "First real line")
        let clipped = TaskStatusResolver.delegateJobName(of: delegate(input: ["prompt": jstr(long)]))
        XCTAssertEqual(clipped.utf16.count, TaskStatusResolver.delegateNameMax)
        XCTAssertTrue(clipped.hasSuffix("…"))
        XCTAssertEqual(TaskStatusResolver.delegateJobName(of: delegate()), "")
    }

    func testARunningJobMakesTheFinishedCallReadRunning() {
        let part = delegate(output: started)
        for status in ["running", "paused", "Running"] {
            let ctx = TaskStatusContext(jobStatusByID: ["198262c2": status])
            let resolved = TaskStatusResolver.applying(ctx, to: part)
            XCTAssertEqual(ToolActivity.describe(resolved).status, .running, status)
            XCTAssertEqual(ToolActivity.describe(resolved).label, "Running background job you-are-the-ship-gate")
        }
        let run = ToolRun(id: "d1", parts: [part])
        XCTAssertEqual(run.resolvingTasks(TaskStatusContext(jobStatusByID: ["198262c2": "running"])).summary.tone, .running)
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
        XCTAssertEqual(ToolActivity.describe(TaskStatusResolver.applying(ctx, to: part)).status, .running)
        XCTAssertEqual(ToolActivity.describe(part).label, "Started background job you-are-the-ship-gate")
    }

    func testRunSummaryCountsBackgroundJobs() {
        XCTAssertEqual(ToolActivity.summarize([delegate(output: started)]).label,
                       "Started background job you-are-the-ship-gate")
        let two = ToolActivity.summarize([delegate(output: started), tool("d2", "delegate_delegate")])
        XCTAssertEqual(two.label, "Started 2 background jobs")
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
