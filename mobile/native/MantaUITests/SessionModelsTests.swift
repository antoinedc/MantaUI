import XCTest
@testable import MantaUI

final class SessionModelsTests: XCTestCase {

    /// Fixed "now" so idle-subtitle recency and the card tests are deterministic.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - §7.1a subtitle table

    func testSubtitleSubagentsReplacesRunningAndModel() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 3, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "3 subagents")
    }

    func testSubtitleSubagentsSingular() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 1, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "1 subagent")
    }

    func testSubtitleRunningShowsModel() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 0, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "running · opus 4.8")
    }

    func testSubtitleRunningWithoutModelFallsBackToRunning() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "running")
    }

    func testSubtitleNeedsYouWhenBlocked() {
        let s = SessionRowStatus(running: false, attention: true, subagentsRunning: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "needs you")
    }

    // MARK: - §7.1a progress label (BET-791)

    func testSubtitleWorkingProgressLabelReplacesRunningAndModel() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 0, modelLabel: "opus 4.8", progressLabel: "Running integration tests")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "Running integration tests")
    }

    func testSubtitleWorkingProgressLabelEmptyFallsBackToRunning() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 0, modelLabel: nil, progressLabel: "")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "running")
    }

    func testSubtitleProgressLabelStillLosesToSubagents() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 2, modelLabel: nil, progressLabel: "Running integration tests")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "2 subagents")
    }

    func testSubtitleIdleIsNil() {
        let s = SessionRowStatus(running: false, attention: false, subagentsRunning: 0, modelLabel: nil)
        XCTAssertNil(SessionRowSubtitle.text(for: s, now: now))
    }

    // MARK: - §7.1 status dot

    func testDotNeedsYouTakesPrecedenceOverRunning() {
        let s = SessionRowStatus(running: true, attention: true, subagentsRunning: 0, modelLabel: nil)
        XCTAssertEqual(SessionDotState.forRow(s), .needsYou)
    }

    func testDotRunning() {
        XCTAssertEqual(SessionDotState.forRow(SessionRowStatus(running: true, attention: false, subagentsRunning: 0, modelLabel: nil)), .running)
    }

    func testDotIdle() {
        XCTAssertEqual(SessionDotState.forRow(SessionRowStatus(running: false, attention: false, subagentsRunning: 0, modelLabel: nil)), .idle)
    }

    // MARK: - Timer / duration

    func testRunningDurationWording() {
        XCTAssertEqual(SessionTimerFormat.runningDuration(36), "36 seconds")
        XCTAssertEqual(SessionTimerFormat.runningDuration(240), "4 minutes")
        XCTAssertEqual(SessionTimerFormat.runningDuration(60), "1 minute")
        XCTAssertEqual(SessionTimerFormat.runningDuration(1), "1 second")
    }

    func testLiveElapsedKeepsSeconds() {
        XCTAssertEqual(SessionTimerFormat.liveElapsed(5), "5s")
        XCTAssertEqual(SessionTimerFormat.liveElapsed(72), "1m 12s")
        XCTAssertEqual(SessionTimerFormat.liveElapsed(60), "1m 0s")
        XCTAssertEqual(SessionTimerFormat.liveElapsed(3725), "1h 2m")
    }

    // MARK: - BET-897 idle recency

    func testRelativeRecencyBuckets() {
        XCTAssertEqual(SessionTimerFormat.relative(0), "just now")
        XCTAssertEqual(SessionTimerFormat.relative(59), "just now")
        XCTAssertEqual(SessionTimerFormat.relative(60), "1m ago")
        // The binding formatter uses COARSE buckets (m < 60, h < 24), so inputs
        // that cross a threshold normalize down: 90 min → 1h, 25 h → 1d.
        XCTAssertEqual(SessionTimerFormat.relative(90 * 60), "1h ago")
        XCTAssertEqual(SessionTimerFormat.relative(25 * 60 * 60), "1d ago")
        XCTAssertEqual(SessionTimerFormat.relative(3 * 24 * 60 * 60), "3d ago")
    }

    func testRelativeClampsNegative() {
        XCTAssertEqual(SessionTimerFormat.relative(-5), "just now")
    }

    // MARK: - BET-897 idle subtitle (model + recency)

    func testIdleSubtitleModelOnly() {
        let s = SessionRowStatus(running: false, attention: false, subagentsRunning: 0, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "opus 4.8")
    }

    func testIdleSubtitleRecencyOnly() {
        let s = SessionRowStatus(running: false, attention: false, subagentsRunning: 0,
                                 modelLabel: nil, lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "1h ago")
    }

    func testIdleSubtitleModelAndRecencyOrderAndSeparator() {
        let s = SessionRowStatus(running: false, attention: false, subagentsRunning: 0,
                                 modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "opus 4.8 · 1h ago")
    }

    func testIdleSubtitleNothingKnownIsNil() {
        let s = SessionRowStatus(running: false, attention: false, subagentsRunning: 0,
                                 modelLabel: nil, lastActivity: nil)
        XCTAssertNil(SessionRowSubtitle.text(for: s, now: now))
    }

    func testIdleSubtitleTerminalWinsOverModelAndRecency() {
        let s = SessionRowStatus(running: false, attention: false, subagentsRunning: 0,
                                 modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600),
                                 isTerminal: true)
        XCTAssertEqual(SessionRowSubtitle.text(for: s, now: now), "terminal")
    }

    func testIdleSubtitleRunningAttentionSubagentPrecedenceUnchanged() {
        // Subagents win over an idle model/recency line.
        let subagents = SessionRowStatus(running: true, attention: false, subagentsRunning: 2,
                                         modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: subagents, now: now), "2 subagents")
        // Running wins over the idle tail.
        let running = SessionRowStatus(running: true, attention: false, subagentsRunning: 0,
                                       modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: running, now: now), "running · opus 4.8")
        // Attention wins over the idle tail even with a recency present.
        let attention = SessionRowStatus(running: false, attention: true, subagentsRunning: 0,
                                         modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: attention, now: now), "needs you")
        // A terminal row whose running flag is somehow true still reports running.
        let terminalRunning = SessionRowStatus(running: true, attention: false, subagentsRunning: 0,
                                               modelLabel: nil, isTerminal: true)
        XCTAssertEqual(SessionRowSubtitle.text(for: terminalRunning, now: now), "running")
    }

    // MARK: - BET-897 card position (corners + separator)

    func testCardPositionSingleRow() {
        XCTAssertEqual(SessionCardPosition.at(index: 0, count: 1), .only)
        XCTAssertTrue(SessionCardPosition.only.roundsTop)
        XCTAssertTrue(SessionCardPosition.only.roundsBottom)
        XCTAssertFalse(SessionCardPosition.only.showsSeparator)
    }

    func testCardPositionFirstRowOfTwo() {
        XCTAssertEqual(SessionCardPosition.at(index: 0, count: 2), .first)
        XCTAssertTrue(SessionCardPosition.first.roundsTop)
        XCTAssertFalse(SessionCardPosition.first.roundsBottom)
        XCTAssertFalse(SessionCardPosition.first.showsSeparator)
    }

    func testCardPositionLastRowOfTwo() {
        XCTAssertEqual(SessionCardPosition.at(index: 1, count: 2), .last)
        XCTAssertFalse(SessionCardPosition.last.roundsTop)
        XCTAssertTrue(SessionCardPosition.last.roundsBottom)
        XCTAssertTrue(SessionCardPosition.last.showsSeparator)
    }

    func testCardPositionMiddleRowOfThree() {
        XCTAssertEqual(SessionCardPosition.at(index: 1, count: 3), .middle)
        XCTAssertFalse(SessionCardPosition.middle.roundsTop)
        XCTAssertFalse(SessionCardPosition.middle.roundsBottom)
        XCTAssertTrue(SessionCardPosition.middle.showsSeparator)
    }

    func testCardPositionThreeRowEdges() {
        XCTAssertEqual(SessionCardPosition.at(index: 0, count: 3), .first)
        XCTAssertEqual(SessionCardPosition.at(index: 2, count: 3), .last)
    }

    // MARK: - Pin identity

    func testWindowPinID() {
        XCTAssertEqual(SessionPinID.window("ethernal", index: 3), "ethernal/3")
    }

    // MARK: - §7.3 delete undo window

    func testPendingDeleteExpiry() {
        let now = Date()
        let pending = PendingDelete(target: .window(session: "s", index: 0), pinID: "s/0", startedAt: now)
        XCTAssertFalse(pending.expired(now: now.addingTimeInterval(4)))
        XCTAssertTrue(pending.expired(now: now.addingTimeInterval(5)))
    }

    // MARK: - Model label

    func testModelLabelAnthropicCollapses() {
        XCTAssertEqual(ModelLabel.text(providerID: "anthropic", modelID: "claude-opus-4-7"), "opus 4.7")
        XCTAssertEqual(ModelLabel.text(providerID: "anthropic", modelID: "claude-sonnet-4-6"), "sonnet 4.6")
    }

    func testModelLabelUnknownFallsBackHonestly() {
        XCTAssertEqual(ModelLabel.text(providerID: "deepseek", modelID: "deepseek-chat"), "deepseek chat")
        XCTAssertEqual(ModelLabel.text(providerID: "anthropic", modelID: "custom-thing"), "custom thing")
    }

    // MARK: - Folder path helpers (folderPicker.ts port)

    func testBreadcrumbsTilde() {
        XCTAssertEqual(FolderPath.breadcrumbs("~/code/foo"), ["~", "~/code", "~/code/foo"])
        XCTAssertEqual(FolderPath.breadcrumbs("~"), ["~"])
    }

    func testBreadcrumbsAbsolute() {
        XCTAssertEqual(FolderPath.breadcrumbs("/home/dev/code"), ["/", "/home", "/home/dev", "/home/dev/code"])
    }

    func testParentPath() {
        XCTAssertEqual(FolderPath.parentPath("~/code/foo"), "~/code")
        XCTAssertEqual(FolderPath.parentPath("~/code"), "~")
        XCTAssertEqual(FolderPath.parentPath("/a/b"), "/a")
        XCTAssertEqual(FolderPath.parentPath("/"), "/")
    }

    func testCrumbLabel() {
        XCTAssertEqual(FolderPath.crumbLabel("~/code/foo"), "foo")
        XCTAssertEqual(FolderPath.crumbLabel("/"), "/")
        XCTAssertEqual(FolderPath.crumbLabel("~"), "~")
    }

    func testIsDimmed() {
        XCTAssertTrue(FolderPath.isDimmed("node_modules"))
        XCTAssertTrue(FolderPath.isDimmed(".git"))
        XCTAssertFalse(FolderPath.isDimmed("src"))
    }

    // MARK: - Worktree helpers

    private func wt(_ path: String, branch: String? = "main") -> MantaWorktree {
        MantaWorktree(path: path, head: "abc", branch: branch, bare: false, detached: false)
    }

    func testWorktreeBadgeOnlyForMultiple() {
        XCTAssertEqual(WorktreeInfoLogic.badge([wt("/a")]), "")
        XCTAssertEqual(WorktreeInfoLogic.badge([wt("/a"), wt("/b")]), "⎇ 2 worktrees")
        XCTAssertEqual(WorktreeInfoLogic.badge(nil), "")
    }

    func testHasFanOutThreshold() {
        XCTAssertFalse(WorktreeInfoLogic.hasFanOut([wt("/a")]))
        XCTAssertTrue(WorktreeInfoLogic.hasFanOut([wt("/a"), wt("/b")]))
        XCTAssertFalse(WorktreeInfoLogic.hasFanOut(nil))
    }

    func testWorktreeNameIsBasename() {
        XCTAssertEqual(WorktreeInfoLogic.name(wt("/home/dev/ethernal")), "ethernal")
    }

    func testGitStateLabelFromFirstWorktree() {
        XCTAssertEqual(WorktreeInfoLogic.gitStateLabel([wt("/a", branch: "main")]), "⎇ main")
        XCTAssertEqual(WorktreeInfoLogic.gitStateLabel([]), "")
    }

    // MARK: - BET-673 turn-complete haptic (all four gates)

    func testTurnCompleteHapticFiresWhenAllGatesPass() {
        XCTAssertTrue(shouldFireTurnCompleteHaptic(
            turnCompleteEdge: true, showScrollToBottom: true, isActive: true, hapticsEnabled: true))
    }

    func testTurnCompleteHapticNoEdge() {
        XCTAssertFalse(shouldFireTurnCompleteHaptic(
            turnCompleteEdge: false, showScrollToBottom: true, isActive: true, hapticsEnabled: true))
    }

    func testTurnCompleteHapticNoScrolledUp() {
        XCTAssertFalse(shouldFireTurnCompleteHaptic(
            turnCompleteEdge: true, showScrollToBottom: false, isActive: true, hapticsEnabled: true))
    }

    func testTurnCompleteHapticInactiveScene() {
        XCTAssertFalse(shouldFireTurnCompleteHaptic(
            turnCompleteEdge: true, showScrollToBottom: true, isActive: false, hapticsEnabled: true))
    }

    func testTurnCompleteHapticHapticsDisabled() {
        XCTAssertFalse(shouldFireTurnCompleteHaptic(
            turnCompleteEdge: true, showScrollToBottom: true, isActive: true, hapticsEnabled: false))
    }
}

// MARK: - BET-746 rename/fork failure feedback

@MainActor
private final class SessionListMutationStub: SessionListMutationAPI {
    var renameError: Error?
    var forkError: Error?
    var renameCalls = 0
    var forkCalls = 0

    func renameWindow(session: String, index: Int, newName: String) async throws {
        renameCalls += 1
        if let error = renameError { throw error }
    }

    func forkSession(sessionId: String, sessionName: String, windowName: String) async throws {
        forkCalls += 1
        if let error = forkError { throw error }
    }
}

private enum SessionListMutationTestError: Error {
    case rejected
}

@MainActor
final class SessionListMutationTests: XCTestCase {

    private func makeStore(_ stub: SessionListMutationStub) -> SessionListStore {
        // Dead localhost port so any stray background config/refresh I/O fails
        // fast and is swallowed; the mutation seam is what these tests drive.
        SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: MantaEventStore(),
            mutations: stub
        )
    }

    private func project(_ name: String, _ window: String) -> MantaProject {
        MantaProject(
            tmuxSession: name,
            defaultCwd: "/tmp",
            windows: [MantaWindow(index: 0, name: window, active: false, paneCurrentPath: "", opencodeSessionId: nil, worktreePath: nil)],
            attached: false,
            mantaOwned: nil
        )
    }

    func testRenameFailureLeavesListUnchangedAndPublishesMessage() async {
        let stub = SessionListMutationStub()
        stub.renameError = SessionListMutationTestError.rejected
        let store = makeStore(stub)
        let snapshot = [project("ethernal", "dev"), project("manta", "main")]
        store.applyProjects(snapshot)

        await store.renameSession(project: "ethernal", index: 0, newName: "renamed")

        XCTAssertEqual(stub.renameCalls, 1)
        XCTAssertEqual(store.actionMessage, "Couldn't rename — check the connection")
        XCTAssertEqual(store.projects, snapshot)
    }

    func testForkFailureLeavesListUnchangedAndPublishesMessage() async {
        let stub = SessionListMutationStub()
        stub.forkError = SessionListMutationTestError.rejected
        let store = makeStore(stub)
        let snapshot = [project("ethernal", "dev")]
        store.applyProjects(snapshot)

        await store.forkSession(sessionId: "ses", project: "ethernal", newName: "dev fork")

        XCTAssertEqual(stub.forkCalls, 1)
        XCTAssertEqual(store.actionMessage, "Couldn't fork — check the connection")
        XCTAssertEqual(store.projects, snapshot)
    }

    func testRenameSuccessPublishesNoFailure() async {
        let stub = SessionListMutationStub()
        let store = makeStore(stub)
        store.applyProjects([project("ethernal", "dev")])

        await store.renameSession(project: "ethernal", index: 0, newName: "renamed")

        XCTAssertEqual(stub.renameCalls, 1)
        XCTAssertNil(store.actionMessage)
    }

    func testForkSuccessPublishesNoFailure() async {
        let stub = SessionListMutationStub()
        let store = makeStore(stub)
        store.applyProjects([project("ethernal", "dev")])

        await store.forkSession(sessionId: "ses", project: "ethernal", newName: "dev fork")

        XCTAssertEqual(stub.forkCalls, 1)
        XCTAssertNil(store.actionMessage)
    }
}
