import XCTest
@testable import MantaUI

final class SessionModelsTests: XCTestCase {

    // MARK: - §7.1a subtitle table

    func testSubtitleSubagentsReplacesRunningAndModel() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 3, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "3 subagents")
    }

    func testSubtitleSubagentsSingular() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 1, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "1 subagent")
    }

    func testSubtitleRunningShowsModel() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 0, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "running · opus 4.8")
    }

    func testSubtitleRunningWithoutModelFallsBackToRunning() {
        let s = SessionRowStatus(running: true, attention: false, subagentsRunning: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "running")
    }

    func testSubtitleNeedsYouWhenBlocked() {
        let s = SessionRowStatus(running: false, attention: true, subagentsRunning: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "needs you")
    }

    func testSubtitleIdleIsNil() {
        let s = SessionRowStatus(running: false, attention: false, subagentsRunning: 0, modelLabel: nil)
        XCTAssertNil(SessionRowSubtitle.text(for: s))
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

    func testElapsedCompact() {
        XCTAssertEqual(SessionTimerFormat.elapsed(5), "5s")
        XCTAssertEqual(SessionTimerFormat.elapsed(120), "2m")
        XCTAssertEqual(SessionTimerFormat.elapsed(3720), "1h")
    }

    func testRunningDurationWording() {
        XCTAssertEqual(SessionTimerFormat.runningDuration(36), "36 seconds")
        XCTAssertEqual(SessionTimerFormat.runningDuration(240), "4 minutes")
        XCTAssertEqual(SessionTimerFormat.runningDuration(60), "1 minute")
        XCTAssertEqual(SessionTimerFormat.runningDuration(1), "1 second")
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
}
