import XCTest
import Combine
@testable import MantaUI

// ===========================================================================
// WS04 — the session-list STORE's orchestration, against a fake mutation seam
// (Mac-only: the store needs the event store and Combine).
//
// Covers rename/rename-project, closing a whole project, the serialized close
// queue with its worktree prompts and real-outcome feedback, the launcher
// catalog, the stopped-conversation list and recents. The pure decisions behind
// these are in `SessionsTests` (Linux-eligible).
// ===========================================================================

/// A scriptable `SessionListMutationAPI`. Every call that touches the box goes
/// through `enter()`, which yields once so overlapping calls would be observed
/// as `maxInFlight > 1`.
@MainActor
final class SessionListFake: SessionListMutationAPI {
    var renameError: Error?
    var forkError: Error?
    var renameCalls = 0
    var forkCalls = 0

    var projectRenameError: Error?
    var projectRenameCalls: [String] = []

    var deleteSessionCalls: [String] = []
    var killWindowCalls: [String] = []
    /// `"<project>#<index>"` keys whose kill throws.
    var killFailures: Set<String> = []

    var killProjectCalls: [String] = []
    var killProjectError: Error?
    var metaDeleteCalls: [String] = []
    var metaDeleteError: Error?

    var removalCalls: [(path: String, force: Bool)] = []
    /// By worktree path; a path with no entry is removed cleanly.
    var removalResults: [String: SessionWorktreeRemoval] = [:]
    var forcedRemovalResults: [String: SessionWorktreeRemoval] = [:]
    var removalErrors: Set<String> = []

    var config: [String: JSONValue]? = [:]
    var configError: Error?
    var launcherResults: [Result<[AvailableLauncher], Error>] = []
    var stopped: Result<SessionStoppedList, Error> = .success(SessionStoppedList())
    var stoppedCalls = 0

    /// Keys (`"<project>#<index>"`) whose `killWindow` suspends until `release`.
    var heldKills: Set<String> = []
    /// Kills that have STARTED (before any hold), in order.
    private(set) var killEntered: [String] = []
    private var gates: [String: CheckedContinuation<Void, Never>] = [:]

    private(set) var inFlight = 0
    private(set) var maxInFlight = 0

    func isHolding(_ key: String) -> Bool { gates[key] != nil }

    func release(_ key: String) {
        gates.removeValue(forKey: key)?.resume()
    }

    private func enter() async {
        inFlight += 1
        maxInFlight = max(maxInFlight, inFlight)
        await Task.yield()
        inFlight -= 1
    }

    func renameWindow(session: String, index: Int, newName: String) async throws {
        renameCalls += 1
        if let error = renameError { throw error }
    }

    func forkSession(sessionId: String, sessionName: String, windowName: String) async throws {
        forkCalls += 1
        if let error = forkError { throw error }
    }

    func renameProject(oldName: String, newName: String) async throws {
        projectRenameCalls.append("\(oldName)->\(newName)")
        if let error = projectRenameError { throw error }
    }

    func deleteSession(sessionId: String, sessionName: String, windowIndex: Int) async throws {
        await enter()
        let key = "\(sessionName)#\(windowIndex)"
        deleteSessionCalls.append(key)
        if killFailures.contains(key) { throw MantaError.server("tmux said no") }
    }

    func killWindow(session: String, index: Int) async throws {
        await enter()
        let key = "\(session)#\(index)"
        killEntered.append(key)
        if heldKills.contains(key) {
            await withCheckedContinuation { gates[key] = $0 }
        }
        killWindowCalls.append(key)
        if killFailures.contains(key) { throw MantaError.server("tmux said no") }
    }

    func killProject(_ name: String) async throws {
        await enter()
        killProjectCalls.append(name)
        if let error = killProjectError { throw error }
    }

    func deleteProjectMeta(_ name: String) async throws {
        metaDeleteCalls.append(name)
        if let error = metaDeleteError { throw error }
    }

    func removeWorktree(path: String, force: Bool) async throws -> SessionWorktreeRemoval {
        await enter()
        removalCalls.append((path, force))
        if removalErrors.contains(path) { throw MantaError.server("git exploded") }
        if force { return forcedRemovalResults[path] ?? SessionWorktreeRemoval(removed: true) }
        return removalResults[path] ?? SessionWorktreeRemoval(removed: true)
    }

    func configGet() async throws -> [String: JSONValue]? {
        if let configError { throw configError }
        return config
    }

    private(set) var launcherCalls = 0

    func launchersList() async throws -> [AvailableLauncher] {
        launcherCalls += 1
        await Task.yield()
        guard !launcherResults.isEmpty else { return [] }
        return try launcherResults.removeFirst().get()
    }

    func usageStoppedList() async throws -> SessionStoppedList {
        stoppedCalls += 1
        return try stopped.get()
    }
}

@MainActor
final class SessionStoreTests: XCTestCase {
    private var suites: [String] = []

    override func tearDown() {
        for name in suites { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        suites = []
        super.tearDown()
    }

    private func defaults() -> UserDefaults {
        let name = "SessionStoreTests.\(UUID().uuidString)"
        suites.append(name)
        return UserDefaults(suiteName: name) ?? .standard
    }

    private func makeStore(_ fake: SessionListFake) -> SessionListStore {
        // Dead localhost port so any stray background I/O fails fast and is
        // swallowed; the seam is what these tests drive.
        SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: MantaEventStore(),
            mutations: fake,
            defaults: defaults()
        )
    }

    private func window(_ index: Int, _ name: String = "w", sid: String? = nil, worktree: String? = nil,
                        owner: String? = nil) -> MantaWindow {
        MantaWindow(index: index, name: name, active: false, paneCurrentPath: "/p", opencodeSessionId: sid,
                    worktreePath: worktree, owner: owner)
    }

    private func project(_ name: String, _ windows: [MantaWindow]) -> MantaProject {
        MantaProject(tmuxSession: name, defaultCwd: "/p", windows: windows, attached: false, mantaOwned: nil)
    }

    private let cleanOnClose: [String: JSONValue] = ["worktreeCleanOnClose": .bool(true)]
    private let dirty = SessionWorktreeRemoval(removed: false, reason: "dirty")

    // MARK: - Rename

    func testRenameFailureReturnsMessageAndDoesNotRefresh() async {
        let fake = SessionListFake()
        fake.renameError = MantaError.server("duplicate session name")
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, "a")])])

        let message = await store.renameSession(project: "p", index: 0, newName: "b")

        XCTAssertEqual(message, "Couldn't rename — duplicate session name")
        XCTAssertEqual(store.refreshRequestCount, 0)
        XCTAssertEqual(store.projects.first?.windows.first?.name, "a")
    }

    func testRenameSuccessRefreshes() async {
        let fake = SessionListFake()
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, "a")])])

        let message = await store.renameSession(project: "p", index: 0, newName: "b")

        XCTAssertNil(message)
        XCTAssertEqual(fake.renameCalls, 1)
        XCTAssertEqual(store.refreshRequestCount, 1)
    }

    func testRenameProjectFailureReturnsMessage() async {
        let fake = SessionListFake()
        fake.projectRenameError = MantaError.server("duplicate session: x")
        let store = makeStore(fake)

        let message = await store.renameProject(oldName: "p", newName: "x")

        XCTAssertEqual(message, "Couldn't rename — duplicate session: x")
        XCTAssertEqual(store.refreshRequestCount, 0)
    }

    func testRenameProjectSuccessRefreshes() async {
        let fake = SessionListFake()
        let store = makeStore(fake)

        let message = await store.renameProject(oldName: "p", newName: "x")

        XCTAssertNil(message)
        XCTAssertEqual(fake.projectRenameCalls, ["p->x"])
        XCTAssertEqual(store.refreshRequestCount, 1)
    }

    // MARK: - Close a whole project

    func testCloseProjectKeepsDirtyWorktreesAndStillKills() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        fake.removalResults["/wt/b"] = dirty
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, "a", worktree: "/wt/a"), window(1, "b", worktree: "/wt/b")])])

        let report = await store.closeProject("p")

        XCTAssertEqual(report.keptWorktrees, ["/wt/b"])
        XCTAssertTrue(report.killed)
        XCTAssertEqual(fake.killProjectCalls, ["p"])
        XCTAssertEqual(fake.metaDeleteCalls, ["p"])
        // Safe-first only: a project close never forces a removal.
        XCTAssertTrue(fake.removalCalls.allSatisfy { !$0.force })
        XCTAssertEqual(store.refreshRequestCount, 1)
    }

    func testCloseProjectRemovesHiddenJobWorktree() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        let store = makeStore(fake)
        store.applyProjects([project("p", [
            window(0, "parent", sid: "ses_p"),
            window(1, "job", sid: "ses_j", worktree: "/wt/job", owner: "job"),
        ])])
        // The job window is hidden from the list but belongs to the project.
        XCTAssertEqual(store.visibleWindows(in: store.projects[0]).map(\.index), [0])

        let report = await store.closeProject("p")

        XCTAssertEqual(fake.removalCalls.map { $0.path }, ["/wt/job"])
        XCTAssertTrue(report.killed)
    }

    func testCloseProjectMetaDeleteFailureStillRefreshes() async {
        let fake = SessionListFake()
        fake.metaDeleteError = MantaError.server("config locked")
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0)])])

        let report = await store.closeProject("p")

        XCTAssertTrue(report.killed)
        XCTAssertEqual(report.errors.count, 1)
        XCTAssertTrue(report.errors[0].contains("config locked"))
        XCTAssertEqual(store.refreshRequestCount, 1)
    }

    func testCloseProjectSkipsWorktreesWhenSettingOff() async {
        let fake = SessionListFake()
        fake.config = ["worktreeCleanOnClose": .bool(false)]
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/a")])])

        let report = await store.closeProject("p")

        XCTAssertTrue(fake.removalCalls.isEmpty)
        XCTAssertTrue(report.killed)
    }

    func testCloseProjectConfigReadFailureRemovesNothing() async {
        let fake = SessionListFake()
        fake.configError = MantaError.transport("offline")
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/a")])])

        let report = await store.closeProject("p")

        XCTAssertTrue(fake.removalCalls.isEmpty, "a setting we can't confirm is off")
        XCTAssertTrue(report.killed)
    }

    func testCloseProjectKillFailureReportsAndStops() async {
        let fake = SessionListFake()
        fake.killProjectError = MantaError.server("no such session")
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0)])])

        let report = await store.closeProject("p")

        XCTAssertFalse(report.killed)
        XCTAssertTrue(fake.metaDeleteCalls.isEmpty)
        XCTAssertEqual(report.errors.count, 1)
    }

    func testCloseCountsAreFromTheCompleteProject() {
        let fake = SessionListFake()
        let store = makeStore(fake)
        store.applyProjects([project("p", [
            window(0, "parent", sid: "ses_p"),
            window(1, "job", sid: "ses_j", worktree: "/wt/job", owner: "job"),
        ])])

        let counts = store.closeCounts(for: "p", cleanOnClose: true)

        XCTAssertEqual(counts?.sessionCount, 2)
        XCTAssertEqual(counts?.worktreeCount, 1)
        XCTAssertNil(store.closeCounts(for: "missing", cleanOnClose: true))
    }

    // MARK: - The close queue

    private func expire(_ store: SessionListStore) {
        store.commitExpiredDeletes(now: Date().addingTimeInterval(PendingDelete.undoWindow + 1))
    }

    func testTwoExpiredDirtyDeletesProduceTwoPromptsInOrder() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        fake.removalResults["/wt/0"] = dirty
        fake.removalResults["/wt/1"] = dirty
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/0"), window(1, worktree: "/wt/1")])])
        store.beginIdleDelete(session: "p", index: 0)
        store.beginIdleDelete(session: "p", index: 1)

        expire(store)
        await store.waitForCloseQueue()

        XCTAssertEqual(store.worktreePrompts.map(\.key), ["p#0", "p#1"])
        XCTAssertTrue(fake.killWindowCalls.isEmpty)
        XCTAssertTrue(store.closeFeedback.isEmpty, "a needs-decision outcome fires nothing")
    }

    func testMixedOutcomesDirtyFailedSuccess() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        fake.removalResults["/wt/0"] = dirty
        fake.killFailures = ["p#1"]
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/0"), window(1), window(2)])])
        for index in 0...2 { store.beginIdleDelete(session: "p", index: index) }

        expire(store)
        await store.waitForCloseQueue()

        XCTAssertEqual(store.worktreePrompts.map(\.key), ["p#0"])
        let kinds = store.closeFeedback.map(\.kind)
        XCTAssertEqual(kinds.count, 2)
        XCTAssertEqual(kinds.filter { $0 == .closed }.count, 1, "exactly one success")
        XCTAssertTrue(kinds.contains { if case .failed(let text) = $0 { return text.contains("tmux said no") }; return false })
    }

    func testCloseRequestsRunOneAtATime() async {
        let fake = SessionListFake()
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0), window(1), window(2), window(3)])])
        for index in 0...3 { store.beginIdleDelete(session: "p", index: index) }

        expire(store)
        await store.waitForCloseQueue()

        XCTAssertEqual(fake.killWindowCalls, ["p#0", "p#1", "p#2", "p#3"])
        XCTAssertEqual(fake.maxInFlight, 1)
    }

    func testChatWindowsCloseThroughDeleteSession() async {
        let fake = SessionListFake()
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, sid: "ses_1")])])
        store.enqueueClose(project: "p", index: 0)
        await store.waitForCloseQueue()

        XCTAssertEqual(fake.deleteSessionCalls, ["p#0"])
        XCTAssertTrue(fake.killWindowCalls.isEmpty)
    }

    func testCancelPromptRestoresRowWithoutRPC() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        fake.removalResults["/wt/0"] = dirty
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/0")])])
        store.beginIdleDelete(session: "p", index: 0)
        expire(store)
        await store.waitForCloseQueue()
        let callsBefore = fake.removalCalls.count

        store.resolveWorktreePrompt(key: "p#0", decision: .cancel)
        await store.waitForCloseQueue()

        XCTAssertTrue(store.worktreePrompts.isEmpty)
        XCTAssertEqual(fake.removalCalls.count, callsBefore)
        XCTAssertTrue(fake.killWindowCalls.isEmpty)
        XCTAssertEqual(store.projects.first?.windows.count, 1, "the row stays")
    }

    func testKeepEnqueuesKillWithNotice() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        fake.removalResults["/wt/0"] = dirty
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/0")])])
        store.beginIdleDelete(session: "p", index: 0)
        expire(store)
        await store.waitForCloseQueue()

        store.resolveWorktreePrompt(key: "p#0", decision: .keep)
        await store.waitForCloseQueue()

        XCTAssertEqual(fake.killWindowCalls, ["p#0"])
        XCTAssertEqual(store.closeFeedback.count, 1)
        guard case .closedWithNotice(let text)? = store.closeFeedback.first?.kind else {
            return XCTFail("expected a notice")
        }
        XCTAssertTrue(text.contains("/wt/0"))
    }

    func testRemoveForcesTheWorktreeThenKills() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        fake.removalResults["/wt/0"] = dirty
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/0")])])
        store.beginIdleDelete(session: "p", index: 0)
        expire(store)
        await store.waitForCloseQueue()

        store.resolveWorktreePrompt(key: "p#0", decision: .remove)
        await store.waitForCloseQueue()

        XCTAssertEqual(fake.removalCalls.map { $0.force }, [false, true])
        XCTAssertEqual(fake.killWindowCalls, ["p#0"])
        XCTAssertEqual(store.closeFeedback.map(\.kind), [.closed])
    }

    func testNoSuccessFeedbackWhenKillFails() async {
        let fake = SessionListFake()
        fake.killFailures = ["p#0"]
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0)])])
        store.enqueueClose(project: "p", index: 0)
        await store.waitForCloseQueue()

        XCTAssertFalse(store.closeFeedback.contains { $0.kind == .closed })
        XCTAssertEqual(store.closeFeedback.count, 1)
        guard case .failed(let text)? = store.closeFeedback.first?.kind else { return XCTFail("expected a failure") }
        XCTAssertTrue(text.hasPrefix("Couldn't delete —"))
    }

    func testRemovalErrorStillKillsAndReports() async {
        let fake = SessionListFake()
        fake.config = cleanOnClose
        fake.removalErrors = ["/wt/0"]
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0, worktree: "/wt/0")])])
        store.enqueueClose(project: "p", index: 0)
        await store.waitForCloseQueue()

        XCTAssertEqual(fake.killWindowCalls, ["p#0"])
        guard case .closedWithNotice(let text)? = store.closeFeedback.first?.kind else { return XCTFail("expected a notice") }
        XCTAssertTrue(text.contains("git exploded"))
    }

    func testConsumeFeedbackRemovesOnlyThatItem() async {
        let fake = SessionListFake()
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0), window(1)])])
        store.enqueueClose(project: "p", index: 0)
        store.enqueueClose(project: "p", index: 1)
        await store.waitForCloseQueue()
        XCTAssertEqual(store.closeFeedback.count, 2)

        store.consumeFeedback(id: store.closeFeedback[0].id)

        XCTAssertEqual(store.closeFeedback.count, 1)
    }

    // MARK: - Launchers

    private let claude = AvailableLauncher(id: "claude", label: "Claude Code")

    func testLauncherSuccessIsAuthoritative() async {
        let fake = SessionListFake()
        fake.launcherResults = [.success([claude])]
        let store = makeStore(fake)
        XCTAssertEqual(store.launcherCatalog, .loading)

        await store.refreshLaunchers()

        XCTAssertEqual(store.launcherCatalog, .loaded(ids: ["claude"]))
        XCTAssertEqual(store.launchers, [claude])
    }

    func testLauncherFailureKeepsLastGood() async {
        let fake = SessionListFake()
        fake.launcherResults = [.success([claude]), .failure(MantaError.transport("offline"))]
        let store = makeStore(fake)
        await store.refreshLaunchers()

        await store.refreshLaunchers()

        guard case .failed(_, let lastGood) = store.launcherCatalog else { return XCTFail("expected failed") }
        XCTAssertEqual(lastGood, ["claude"])
        XCTAssertEqual(store.launchers, [claude])
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: store.launcherCatalog),
                       .ready(.cli(launcherID: "claude")))
    }

    func testLauncherInitialFailureIsFailedWithoutSnapshot() async {
        let fake = SessionListFake()
        fake.launcherResults = [.failure(MantaError.transport("offline"))]
        let store = makeStore(fake)

        await store.refreshLaunchers()

        guard case .failed(_, let lastGood) = store.launcherCatalog else { return XCTFail("expected failed") }
        XCTAssertNil(lastGood)
        XCTAssertEqual(SessionModeResolution.resolve(saved: .cli(launcherID: "claude"), catalog: store.launcherCatalog),
                       .waiting(launcherID: "claude"))
    }

    func testBoxChangeResetsBoxStateButKeepsRecents() async {
        let fake = SessionListFake()
        fake.launcherResults = [.success([claude])]
        fake.stopped = .success(SessionStoppedList(records: [SessionStoppedRecord(workspace: "w", conversation: "ses_1", provider: "claude", stoppedAt: 1)]))
        let store = makeStore(fake)
        store.noteOpened(project: "p", index: 0)
        await store.refreshLaunchers()
        await store.refreshStopped()

        store.resetForBoxChange()

        XCTAssertEqual(store.launcherCatalog, .loading)
        XCTAssertTrue(store.launchers.isEmpty)
        XCTAssertTrue(store.stoppedRecords.isEmpty)
        XCTAssertNil(store.stoppedLastLooked)
        XCTAssertTrue(store.worktreePrompts.isEmpty)
        XCTAssertEqual(store.recents, ["p#0"])
    }

    func testBoxResetDuringCloseDoesNotStartSecondWorker() async {
        let fake = SessionListFake()
        fake.heldKills = ["p#0", "p#1"]
        let store = makeStore(fake)
        store.applyProjects([project("p", [window(0), window(1), window(2)])])

        store.enqueueClose(project: "p", index: 0)           // old worker, held mid-kill
        await waitUntil { fake.isHolding("p#0") }
        store.resetForBoxChange()
        store.applyProjects([project("p", [window(0), window(1), window(2)])])
        store.enqueueClose(project: "p", index: 1)           // new worker, held mid-kill
        await waitUntil { fake.isHolding("p#1") }

        fake.release("p#0")                                   // the OLD worker finishes
        await waitUntil { fake.killWindowCalls.contains("p#0") }
        for _ in 0..<5 { await Task.yield() }
        store.enqueueClose(project: "p", index: 2)            // must queue behind p#1

        for _ in 0..<5 { await Task.yield() }
        XCTAssertFalse(fake.killEntered.contains("p#2"), "a second concurrent worker started")
        fake.release("p#1")
        await store.waitForCloseQueue()
        XCTAssertEqual(fake.killWindowCalls, ["p#0", "p#1", "p#2"])
        // The close that belonged to the old box says nothing in the new one.
        XCTAssertEqual(store.closeFeedback.count, 2)
    }

    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out", file: file, line: line)
    }

    // MARK: - Launch flags are fresh (finding 4)

    func testRefreshLaunchersReReadsSavedFlags() async {
        let fake = SessionListFake()
        fake.launcherResults = [.success([claude]), .success([claude])]
        fake.config = ["launcherFlags": .object(["claude": .object(["skipPermissions": .bool(true)])])]
        let store = makeStore(fake)

        await store.refreshLaunchers()
        XCTAssertEqual(store.launcherFlags["claude"], ["skipPermissions": true])

        // The user changes the flag in Settings; the next refresh sees it.
        fake.config = ["launcherFlags": .object(["claude": .object(["skipPermissions": .bool(false)])])]
        await store.refreshLaunchers()
        XCTAssertEqual(store.launcherFlags["claude"], ["skipPermissions": false])
    }

    func testBoxChangeThenRefreshRestoresFlags() async {
        let fake = SessionListFake()
        fake.launcherResults = [.success([claude]), .success([claude])]
        fake.config = ["launcherFlags": .object(["claude": .object(["skipPermissions": .bool(true)])])]
        let store = makeStore(fake)
        await store.refreshLaunchers()

        store.resetForBoxChange()
        XCTAssertTrue(store.launcherFlags.isEmpty)
        await store.refreshLaunchers()

        XCTAssertEqual(store.launcherFlags["claude"], ["skipPermissions": true])
        XCTAssertEqual(store.launcherCatalog, .loaded(ids: ["claude"]))
    }

    func testConcurrentLauncherRefreshesCoalesce() async {
        let fake = SessionListFake()
        fake.launcherResults = [.success([claude])]
        let store = makeStore(fake)

        async let a: Void = store.refreshLaunchers()
        async let b: Void = store.refreshLaunchers()
        _ = await (a, b)

        XCTAssertEqual(fake.launcherCalls, 1)
        XCTAssertEqual(store.launchers, [claude])
    }

    func testUnchangedLauncherRefreshDoesNotRepublish() async {
        let fake = SessionListFake()
        fake.launcherResults = [.success([claude]), .success([claude])]
        let store = makeStore(fake)
        await store.refreshLaunchers()
        var publishes = 0
        let sub = store.objectWillChange.sink { publishes += 1 }
        defer { sub.cancel() }

        await store.refreshLaunchers()

        XCTAssertEqual(publishes, 0)
    }

    // MARK: - Stopped conversations

    func testStoppedRefetchOnUsageStoppedFrame() async throws {
        let fake = SessionListFake()
        fake.stopped = .success(SessionStoppedList(
            records: [SessionStoppedRecord(workspace: "w", conversation: "ses_1", provider: "claude", stoppedAt: 2_000, armed: nil)],
            lastLooked: 1_000
        ))
        let store = makeStore(fake)

        let other = try MantaStreamFrame.parse(#"{"kind":"delegate.updated","payload":{}}"#)
        XCTAssertNil(store.trackStopped(frame: other))
        XCTAssertEqual(fake.stoppedCalls, 0)

        let frame = try MantaStreamFrame.parse(#"{"kind":"usage-stopped.updated","payload":{}}"#)
        await store.trackStopped(frame: frame)?.value

        XCTAssertEqual(fake.stoppedCalls, 1)
        XCTAssertTrue(store.isStopped(sessionID: "ses_1"))
        XCTAssertEqual(store.stoppedLastLooked, 1_000)
        XCTAssertEqual(store.unarmedStoppedCount, 1)
    }

    func testStoppedFetchFailureKeepsPreviousSet() async {
        let fake = SessionListFake()
        fake.stopped = .success(SessionStoppedList(records: [SessionStoppedRecord(workspace: "w", conversation: "ses_1", provider: "claude", stoppedAt: 1)]))
        let store = makeStore(fake)
        await store.refreshStopped()
        XCTAssertTrue(store.isStopped(sessionID: "ses_1"))

        fake.stopped = .failure(MantaError.server("unknown rpc channel: usage-stopped:list"))
        await store.refreshStopped()

        XCTAssertTrue(store.isStopped(sessionID: "ses_1"))
        XCTAssertEqual(store.stoppedRecords.count, 1)
    }

    func testRowStatusReportsHaltedAndSubagents() async {
        let fake = SessionListFake()
        fake.stopped = .success(SessionStoppedList(records: [SessionStoppedRecord(workspace: "w", conversation: "ses_1", provider: "claude", stoppedAt: 1)]))
        let store = makeStore(fake)
        let w = window(0, "a", sid: "ses_1")
        store.applyProjects([project("p", [w])])
        await store.refreshStopped()

        let status = store.rowStatus(for: w)

        XCTAssertTrue(status.halted)
        XCTAssertEqual(status.runningSubagents, 0)
        XCTAssertEqual(SessionRowSubtitle.text(for: status), "stopped by a provider limit")
    }

    // MARK: - Recents + switcher

    func testRecentsAreStoredMostRecentFirstAndPersist() {
        let defaultsSuite = defaults()
        let fake = SessionListFake()
        let first = SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: MantaEventStore(), mutations: fake, defaults: defaultsSuite
        )
        first.noteOpened(project: "p", index: 0)
        first.noteOpened(project: "p", index: 1)
        first.noteOpened(project: "p", index: 0)
        XCTAssertEqual(first.recents, ["p#0", "p#1"])

        let second = SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: MantaEventStore(), mutations: fake, defaults: defaultsSuite
        )
        XCTAssertEqual(second.recents, ["p#0", "p#1"])
    }

    func testSwitcherCandidatesExcludeJobWindows() {
        let store = makeStore(SessionListFake())
        store.applyProjects([project("p", [window(0, "a", sid: "ses_a"), window(1, "job", sid: "ses_j", owner: "job")])])

        XCTAssertEqual(store.switcherCandidates.map(\.key), ["p#0"])
    }

    func testWindowForSessionID() {
        let store = makeStore(SessionListFake())
        store.applyProjects([project("p", [window(0, "a", sid: "ses_a"), window(1, "b", sid: "ses_b")])])

        XCTAssertEqual(store.window(forSessionID: "ses_b")?.project, "p")
        XCTAssertEqual(store.window(forSessionID: "ses_b")?.window.index, 1)
        XCTAssertNil(store.window(forSessionID: "nope"))
        XCTAssertNil(store.window(forSessionID: ""))
    }

    // MARK: - Mode menu state

    func testCliStateOfTheMenu() {
        XCTAssertEqual(SessionModeCLIState.make(launchers: [], catalog: .loading), .checking)
        XCTAssertEqual(SessionModeCLIState.make(launchers: [], catalog: .failed(message: "x", lastGood: nil)), .failed)
        XCTAssertEqual(SessionModeCLIState.make(launchers: [], catalog: .loaded(ids: [])), .none)
        XCTAssertEqual(SessionModeCLIState.make(launchers: [claude], catalog: .failed(message: "x", lastGood: ["claude"])), .list([claude]))
    }
}
