import XCTest
@testable import MantaUI

final class SessionModelsTests: XCTestCase {

    /// Fixed "now" so idle-subtitle recency and the card tests are deterministic.
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - §7.1a subtitle table

    func testSubtitleBackgroundJobsReplaceRunningAndModel() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 3, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "3 background jobs")
    }

    func testSubtitleBackgroundJobsSingular() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 1, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "1 background job")
    }

    func testSubtitleRunningShowsModel() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 0, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "running · opus 4.8")
    }

    func testSubtitleRunningWithoutModelFallsBackToRunning() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "running")
    }

    func testSubtitleNeedsYouWhenBlocked() {
        let s = SessionRowStatus(running: false, attention: true, backgroundJobs: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "needs you")
    }

    // MARK: - §7.1a progress label (BET-791)

    func testSubtitleWorkingProgressLabelReplacesRunningAndModel() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 0, modelLabel: "opus 4.8", progressLabel: "Running integration tests")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "Running integration tests")
    }

    func testSubtitleWorkingProgressLabelEmptyFallsBackToRunning() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 0, modelLabel: nil, progressLabel: "")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "running")
    }

    func testSubtitleBackgroundJobsStillBeatProgressLabel() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 2, modelLabel: nil, progressLabel: "Running integration tests")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "2 background jobs")
    }

    func testSubtitleIdleIsNil() {
        let s = SessionRowStatus(running: false, attention: false, backgroundJobs: 0, modelLabel: nil)
        XCTAssertNil(SessionRowSubtitle.text(for: s))
    }

    // MARK: - BET-1213 background-job nesting

    private func win(_ index: Int, _ sid: String?) -> MantaWindow {
        MantaWindow(index: index, name: "w\(index)", active: false, paneCurrentPath: "", opencodeSessionId: sid, worktreePath: nil)
    }

    private func job(_ id: String, parent: String?, child: String?, status: String = "running") -> DelegateJob {
        DelegateJob(id: id, parentSessionID: parent, childSessionID: child, status: status)
    }

    private func proj(_ windows: [MantaWindow]) -> MantaProject {
        MantaProject(tmuxSession: "proj", defaultCwd: "/tmp", windows: windows, attached: false, mantaOwned: nil)
    }

    func testNestingHidesChildUnderPresentParent() {
        let p = proj([win(0, "ses_parent"), win(1, "ses_child")])
        let nesting = SessionJobNesting.compute(project: p, jobs: [job("j1", parent: "ses_parent", child: "ses_child")])
        XCTAssertEqual(nesting.hidden, [1])
        XCTAssertEqual(nesting.activeChildCounts, [0: 1])
    }

    func testNestingChildStaysVisibleWhenParentWindowAbsent() {
        // The child window exists but its parent session has no window in the
        // project — the child must NOT be orphaned or hidden.
        let p = proj([win(0, "ses_child")])
        let nesting = SessionJobNesting.compute(project: p, jobs: [job("j1", parent: "ses_gone", child: "ses_child")])
        XCTAssertTrue(nesting.hidden.isEmpty)
        XCTAssertTrue(nesting.activeChildCounts.isEmpty)
    }

    func testNestingIgnoresJobWhoseChildWindowIsAbsent() {
        let p = proj([win(0, "ses_parent")])
        let nesting = SessionJobNesting.compute(project: p, jobs: [job("j1", parent: "ses_parent", child: "ses_no_window")])
        XCTAssertTrue(nesting.hidden.isEmpty)
        XCTAssertTrue(nesting.activeChildCounts.isEmpty)
    }

    func testNestingNoJobsIsANoop() {
        let p = proj([win(0, "ses_a"), win(1, "ses_b")])
        let nesting = SessionJobNesting.compute(project: p, jobs: [])
        XCTAssertTrue(nesting.hidden.isEmpty)
        XCTAssertTrue(nesting.activeChildCounts.isEmpty)
    }

    func testNestingCountsOnlyNonTerminalJobs() {
        // Both children are hidden (any job whose child+parent windows exist),
        // but only the RUNNING one counts toward the parent's background-job
        // subtitle.
        let p = proj([win(0, "ses_parent"), win(1, "ses_run"), win(2, "ses_done")])
        let nesting = SessionJobNesting.compute(project: p, jobs: [
            job("a", parent: "ses_parent", child: "ses_run", status: "running"),
            job("b", parent: "ses_parent", child: "ses_done", status: "done"),
        ])
        XCTAssertEqual(nesting.hidden, [1, 2])
        XCTAssertEqual(nesting.activeChildCounts, [0: 1])
    }

    func testNestingChildOfTerminalJobIsStillHidden() {
        // Desktop hides a nested child window regardless of job status.
        let p = proj([win(0, "ses_parent"), win(1, "ses_done")])
        let nesting = SessionJobNesting.compute(project: p, jobs: [job("a", parent: "ses_parent", child: "ses_done", status: "done")])
        XCTAssertEqual(nesting.hidden, [1])
        XCTAssertTrue(nesting.activeChildCounts.isEmpty)
    }

    // MARK: - §7.1 status dot
    func testDotNeedsYouTakesPrecedenceOverRunning() {
        let s = SessionRowStatus(running: true, attention: true, backgroundJobs: 0, modelLabel: nil)
        XCTAssertEqual(SessionDotState.forRow(s), .needsYou)
    }

    func testDotRunning() {
        XCTAssertEqual(SessionDotState.forRow(SessionRowStatus(running: true, attention: false, backgroundJobs: 0, modelLabel: nil)), .running)
    }

    func testDotIdle() {
        XCTAssertEqual(SessionDotState.forRow(SessionRowStatus(running: false, attention: false, backgroundJobs: 0, modelLabel: nil)), .idle)
    }

    // MARK: - Timer / duration

    func testRunningDurationWording() {
        XCTAssertEqual(SessionTimerFormat.runningDuration(36), "36 seconds")
        XCTAssertEqual(SessionTimerFormat.runningDuration(240), "4 minutes")
        XCTAssertEqual(SessionTimerFormat.runningDuration(60), "1 minute")
        XCTAssertEqual(SessionTimerFormat.runningDuration(1), "1 second")
    }

    func testCompactCanonicalLadder() {
        XCTAssertEqual(SessionTimerFormat.compact(0), "0s")
        XCTAssertEqual(SessionTimerFormat.compact(45), "45s")
        XCTAssertEqual(SessionTimerFormat.compact(59), "59s")
        XCTAssertEqual(SessionTimerFormat.compact(60), "1m")
        XCTAssertEqual(SessionTimerFormat.compact(3_420), "57m")
        XCTAssertEqual(SessionTimerFormat.compact(7_800), "2h10m")
        XCTAssertEqual(SessionTimerFormat.compact(10_620), "2h57m")
        XCTAssertEqual(SessionTimerFormat.compact(10_800), "3h")
    }

    // MARK: - BET-1084 idle age (chip) + in-chat elapsed

    /// Lifted verbatim from the desktop's own `formatAge` test
    /// (src/renderer/chatUtils.test.ts:533-559) — keep these values identical.
    func testAgeLadderMatchesDesktop() {
        XCTAssertEqual(SessionTimerFormat.age(0), "now")
        XCTAssertEqual(SessionTimerFormat.age(59), "now")
        XCTAssertEqual(SessionTimerFormat.age(-5), "now")
        XCTAssertEqual(SessionTimerFormat.age(60), "1m")
        XCTAssertEqual(SessionTimerFormat.age(3599), "59m")
        XCTAssertEqual(SessionTimerFormat.age(3600), "1h")
        XCTAssertEqual(SessionTimerFormat.age(86_399), "23h")
        XCTAssertEqual(SessionTimerFormat.age(86_400), "1d")
        XCTAssertEqual(SessionTimerFormat.age(259_200), "3d")
    }

    func testElapsedKeepsSecondsPastAMinute() {
        XCTAssertEqual(SessionTimerFormat.elapsed(0.4), "<1s")
        XCTAssertEqual(SessionTimerFormat.elapsed(44), "44s")
        XCTAssertEqual(SessionTimerFormat.elapsed(104), "1m44s")
        XCTAssertEqual(SessionTimerFormat.elapsed(3600), "1h0m0s")
        XCTAssertEqual(SessionTimerFormat.elapsed(3661), "1h1m1s")
    }

    func testSessionRowAgeGate() {
        let ttl = 100_000_000.0 // effectively unbounded — TTL-specific cases live in testSessionRowAgeTTL
        let activity = now.addingTimeInterval(-3600)
        // Running rows show no age even with activity known (the dot is the signal).
        let running = SessionRowStatus(running: true, attention: false, backgroundJobs: 0,
                                       modelLabel: nil, lastActivity: activity)
        XCTAssertNil(SessionRowAge.text(for: running, now: now, ttlMs: ttl))
        // Attention rows likewise.
        let attention = SessionRowStatus(running: false, attention: true, backgroundJobs: 0,
                                         modelLabel: nil, lastActivity: activity)
        XCTAssertNil(SessionRowAge.text(for: attention, now: now, ttlMs: ttl))
        // No known activity → no age.
        let none = SessionRowStatus(running: false, attention: false, backgroundJobs: 0,
                                    modelLabel: nil, lastActivity: nil)
        XCTAssertNil(SessionRowAge.text(for: none, now: now, ttlMs: ttl))
        // A plain idle row with activity → the formatted age.
        let idle = SessionRowStatus(running: false, attention: false, backgroundJobs: 0,
                                    modelLabel: "opus 4.8", lastActivity: activity)
        XCTAssertEqual(SessionRowAge.text(for: idle, now: now, ttlMs: ttl), "1h")
    }

    // MARK: - BET-1349 recency (TTL-bounded age chip + All/Recent filter)

    private func recencyStatus(running: Bool = false, attention: Bool = false, lastActivity: Date? = nil) -> SessionRowStatus {
        SessionRowStatus(running: running, attention: attention, backgroundJobs: 0,
                         modelLabel: nil, lastActivity: lastActivity)
    }

    func testRecencyRunningAlwaysRecent() {
        // A very old lastActivity must not matter — the dot is the signal.
        let s = recencyStatus(running: true, lastActivity: now.addingTimeInterval(-86_400))
        XCTAssertTrue(SessionRecency.isRecent(s, now: now, ttlMs: 300_000))
    }

    func testRecencyAttentionAlwaysRecent() {
        let s = recencyStatus(attention: true, lastActivity: now.addingTimeInterval(-86_400))
        XCTAssertTrue(SessionRecency.isRecent(s, now: now, ttlMs: 300_000))
    }

    func testRecencyNilActivityNotRecent() {
        XCTAssertFalse(SessionRecency.isRecent(recencyStatus(), now: now, ttlMs: 300_000))
    }

    func testRecencyInsideTTL() {
        let s = recencyStatus(lastActivity: now.addingTimeInterval(-60))
        XCTAssertTrue(SessionRecency.isRecent(s, now: now, ttlMs: 300_000))
    }

    func testRecencyExactlyAtTTLNotRecent() {
        // 300 s inside a 300_000 ms TTL is the boundary — not recent.
        let s = recencyStatus(lastActivity: now.addingTimeInterval(-300))
        XCTAssertFalse(SessionRecency.isRecent(s, now: now, ttlMs: 300_000))
    }

    func testRecencyPastTTLNotRecent() {
        let s = recencyStatus(lastActivity: now.addingTimeInterval(-3600))
        XCTAssertFalse(SessionRecency.isRecent(s, now: now, ttlMs: 300_000))
    }

    func testCacheTtlMapping() {
        XCTAssertEqual(SessionCacheTtl.ms(for: "5m"), 300_000)
        XCTAssertEqual(SessionCacheTtl.ms(for: "1h"), 3_600_000)
        XCTAssertEqual(SessionCacheTtl.ms(for: "garbage"), 300_000)
        XCTAssertEqual(SessionCacheTtl.ms(for: nil), 300_000)
    }

    func testSessionRowAgeTTL() {
        let ttl = 3_600_000.0 // 1h
        // Inside the TTL → a formatted value.
        let inside = recencyStatus(lastActivity: now.addingTimeInterval(-60))
        XCTAssertEqual(SessionRowAge.text(for: inside, now: now, ttlMs: ttl), "1m")
        // Exactly at the TTL → nil.
        let at = recencyStatus(lastActivity: now.addingTimeInterval(-3600))
        XCTAssertNil(SessionRowAge.text(for: at, now: now, ttlMs: ttl))
        // Past the TTL → nil.
        let past = recencyStatus(lastActivity: now.addingTimeInterval(-7200))
        XCTAssertNil(SessionRowAge.text(for: past, now: now, ttlMs: ttl))
        // Running / attention / nil-activity still nil regardless of TTL.
        XCTAssertNil(SessionRowAge.text(for: recencyStatus(running: true, lastActivity: now), now: now, ttlMs: ttl))
        XCTAssertNil(SessionRowAge.text(for: recencyStatus(attention: true, lastActivity: now), now: now, ttlMs: ttl))
        XCTAssertNil(SessionRowAge.text(for: recencyStatus(), now: now, ttlMs: ttl))
    }

    // MARK: - BET-897 idle subtitle (model only)

    func testIdleSubtitleModelOnly() {
        let s = SessionRowStatus(running: false, attention: false, backgroundJobs: 0, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "opus 4.8")
    }

    func testIdleSubtitleRecencyOnlyBecomesNil() {
        // Recency now lives in the age chip, not the subtitle — a row with
        // activity but no model shows nothing here.
        let s = SessionRowStatus(running: false, attention: false, backgroundJobs: 0,
                                 modelLabel: nil, lastActivity: now.addingTimeInterval(-3600))
        XCTAssertNil(SessionRowSubtitle.text(for: s))
    }

    func testIdleSubtitleModelOnlyIgnoresRecency() {
        // Model alone; recency is carried by the trailing age chip, so it no
        // longer appears here (used to read "opus 4.8 · 1h ago").
        let s = SessionRowStatus(running: false, attention: false, backgroundJobs: 0,
                                 modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "opus 4.8")
    }

    func testIdleSubtitleNothingKnownIsNil() {
        let s = SessionRowStatus(running: false, attention: false, backgroundJobs: 0,
                                 modelLabel: nil, lastActivity: nil)
        XCTAssertNil(SessionRowSubtitle.text(for: s))
    }

    func testIdleSubtitleTerminalWinsOverModelAndRecency() {
        let s = SessionRowStatus(running: false, attention: false, backgroundJobs: 0,
                                 modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600),
                                 isTerminal: true)
        XCTAssertEqual(SessionRowSubtitle.text(for: s), "terminal")
    }

    func testIdleSubtitleRunningAttentionBackgroundJobPrecedenceUnchanged() {
        // Background jobs win over an idle model/recency line.
        let bg = SessionRowStatus(running: true, attention: false, backgroundJobs: 2,
                                  modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: bg), "2 background jobs")
        // Running wins over the idle tail.
        let running = SessionRowStatus(running: true, attention: false, backgroundJobs: 0,
                                       modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: running), "running · opus 4.8")
        // Attention wins over the idle tail even with a recency present.
        let attention = SessionRowStatus(running: false, attention: true, backgroundJobs: 0,
                                         modelLabel: "opus 4.8", lastActivity: now.addingTimeInterval(-3600))
        XCTAssertEqual(SessionRowSubtitle.text(for: attention), "needs you")
        // A terminal row whose running flag is somehow true still reports running.
        let terminalRunning = SessionRowStatus(running: true, attention: false, backgroundJobs: 0,
                                               modelLabel: nil, isTerminal: true)
        XCTAssertEqual(SessionRowSubtitle.text(for: terminalRunning), "running")
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

    // MARK: - BET-1203 model capabilities decode both input shapes

    private func decodeModels(_ json: String) -> [OpencodeModel]? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([OpencodeModel].self, from: data)
    }

    func testCapabilitiesInputListShapeDecodesImage() {
        let models = decodeModels("""
        [{"id":"m","providerID":"anthropic","name":"M","capabilities":{"input":["text","image","pdf"]}}]
        """)
        XCTAssertEqual(models?.count, 1)
        XCTAssertTrue(models?.first?.capabilities?.input?.image == true)
    }

    func testCapabilitiesInputObjectShapeDecodesImageAndOmitsFalseFlag() {
        let models = decodeModels("""
        [{"id":"m","providerID":"anthropic","name":"M","capabilities":{"input":{"text":true,"image":true,"pdf":false}}}]
        """)
        XCTAssertEqual(models?.count, 1)
        let input = models?.first?.capabilities?.input
        XCTAssertTrue(input?.image == true)
        XCTAssertFalse(input?.names.contains("pdf") == true)
    }

    func testCapabilitiesInputObjectImageFalseDecodesAsFalse() {
        let models = decodeModels("""
        [{"id":"m","providerID":"anthropic","name":"M","capabilities":{"input":{"text":true,"image":false}}}]
        """)
        XCTAssertEqual(models?.count, 1)
        XCTAssertTrue(models?.first?.capabilities?.input?.image == false)
    }

    func testCapabilitiesInputGarbageShapeStillDecodesModel() {
        let models = decodeModels("""
        [{"id":"m","providerID":"anthropic","name":"M","capabilities":{"input":42}}]
        """)
        XCTAssertEqual(models?.count, 1)
        XCTAssertTrue(models?.first?.capabilities?.input?.image == false)
    }

    /// The actual production failure: one model in the new (list) shape must not
    /// empty the whole catalogue. A list of two models — first list shape,
    /// second object shape — must return both.
    func testCapabilitiesInputMixedShapesDoNotEmptyTheCatalogue() {
        let models = decodeModels("""
        [
          {"id":"a","providerID":"anthropic","name":"A","capabilities":{"input":["text","image","pdf"]}},
          {"id":"b","providerID":"anthropic","name":"B","capabilities":{"input":{"text":true,"image":true,"pdf":false}}}
        ]
        """)
        XCTAssertEqual(models?.count, 2)
        XCTAssertEqual(models?.first?.id, "a")
        XCTAssertEqual(models?.last?.id, "b")
        XCTAssertTrue(models?.first?.capabilities?.input?.image == true)
        XCTAssertTrue(models?.last?.capabilities?.input?.image == true)
    }

    // MARK: - BET-1259 create-failure messaging

    func testCreateFailureSurfacesServerReason() {
        XCTAssertEqual(SessionCreateFailure.message(for: MantaError.server("boom")), "boom")
    }

    func testCreateFailureEmptyServerMessageFallsBackToGeneric() {
        XCTAssertEqual(SessionCreateFailure.message(for: MantaError.server("")), SessionCreateFailure.generic)
    }

    func testCreateFailureAuthRequired() {
        XCTAssertEqual(SessionCreateFailure.message(for: MantaError.authRequired), "Not signed in to this box.")
    }

    func testCreateFailureUnrelatedErrorFallsBackToGeneric() {
        XCTAssertEqual(SessionCreateFailure.message(for: URLError(.timedOut)), SessionCreateFailure.generic)
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

    // MARK: - Pin ordering (BET-898)

    private func windows(_ names: [String]) -> [MantaWindow] {
        names.enumerated().map { i, name in
            MantaWindow(index: i, name: name, active: false, paneCurrentPath: "", opencodeSessionId: nil, worktreePath: nil)
        }
    }

    private func names(_ ws: [MantaWindow]) -> [String] { ws.map(\.name) }

    func testPinOrderNoPinsReturnsArrayUnchanged() {
        let ws = windows(["a", "b", "c"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [])), ["a", "b", "c"])
    }

    func testPinOrderOnePinnedJumpsToFrontKeepsRestOrder() {
        let ws = windows(["a", "b", "c", "d"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [SessionPinID.window("proj", index: 2)])), ["c", "a", "b", "d"])
    }

    func testPinOrderSeveralPinnedKeepTheirOriginalRelativeOrder() {
        let ws = windows(["a", "b", "c", "d", "e"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [SessionPinID.window("proj", index: 3), SessionPinID.window("proj", index: 1)])), ["b", "d", "a", "c", "e"])
    }

    func testPinOrderOtherProjectPinDoesNotAffect() {
        let ws = windows(["a", "b"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [SessionPinID.window("other", index: 0)])), ["a", "b"])
    }
}

// MARK: - BET-1213 delegate:list failure tolerance
//
// A box that predates delegation answers `delegate:list` with an unknown-
// channel error. That must leave the project list fully working: every window
// visible, no count, no error banner, no empty state. This drives the real
// store seam through a stubbed URLSession (same pattern as
// MantaEventStreamTests' StubTranscriptURLProtocol), with the jobs channel
// returning the server's `{error: "unknown rpc channel: …"}` envelope while
// `tmux:list` succeeds.

@MainActor
final class SessionListJobToleranceTests: XCTestCase {

    private final class StubChannelURLProtocol: URLProtocol {
        nonisolated(unsafe) static var responseBySubstring: [String: String] = [:]

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            let urlString = request.url?.absoluteString ?? ""
            var body = Self.responseBySubstring["default"] ?? #"{"result": null}"#
            for (key, value) in Self.responseBySubstring where urlString.contains(key) {
                body = value
                break
            }
            let data = Data(body.utf8)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}
    }

    private let projectJSON = #"""
    {"result":[{"tmuxSession":"proj","defaultCwd":"/tmp","windows":[
      {"index":0,"name":"a","active":false,"paneCurrentPath":"","opencodeSessionId":"ses_a"},
      {"index":1,"name":"b","active":false,"paneCurrentPath":"","opencodeSessionId":"ses_b"}
    ],"attached":false}]}
    """#

    private func makeAPI() -> MantaAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubChannelURLProtocol.self]
        return MantaAPIClient(
            serverURL: URL(string: "https://box.example")!,
            tokenProvider: { "tok" },
            session: URLSession(configuration: config)
        )
    }

    func testUnknownDelegateChannelLeavesProjectListIntact() async {
        StubChannelURLProtocol.responseBySubstring = [
            "default": #"{"error":"unknown rpc channel: delegate:list"}"#,
            "tmux:list": projectJSON,
        ]
        let store = SessionListStore(api: makeAPI(), eventStore: MantaEventStore())

        await store.refresh()

        // The project list loaded fully despite the failing jobs fetch.
        XCTAssertEqual(store.projects.count, 1)
        let project = store.projects[0]
        XCTAssertEqual(project.windows.count, 2)
        // Every window stays visible — a missing job list hides nothing.
        XCTAssertEqual(store.visibleWindows(in: project).map(\.index), [0, 1])
        // And no window carries a background-job count.
        for w in project.windows {
            XCTAssertEqual(store.rowStatus(for: w).backgroundJobs, 0)
        }
        XCTAssertNil(store.loadError)
    }
}

// MARK: - BET-1350 terminal-window running status (tmux poller frames)

@MainActor
final class TerminalStatusTests: XCTestCase {

    /// Minimal injectable stream so `kind: "status"` frames can be pushed
    /// straight through the store's raw-frame path — no live socket (mirrors
    /// the suite's other `MantaEventStreamControl` fakes).
    @MainActor
    private final class Stream: MantaEventStreamControl {
        var onState: ((MantaConnectionState) -> Void)?
        var onMessage: ((String) -> Void)?
        var onReconnect: (() -> Void)?
        var onConfigError: ((Error) -> Void)?
        var hasConnectedOnce = false
        var currentState: MantaConnectionState = .idle
        func ensure() {}
        func markReconnectAndEnsure() {}
        func retryNow() {}
        func forceReconnect() {}
        func close(reason: String) {}
        func inject(_ text: String) { onMessage?(text) }
    }

    private func makeStore() -> (store: SessionListStore, stream: Stream) {
        let stream = Stream()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let store = SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: eventStore
        )
        return (store, stream)
    }

    private func project(_ session: String, _ window: MantaWindow) -> MantaProject {
        MantaProject(tmuxSession: session, defaultCwd: "/tmp", windows: [window], attached: false, mantaOwned: nil)
    }

    private func terminalWindow(_ index: Int) -> MantaWindow {
        MantaWindow(index: index, name: "dev", active: false, paneCurrentPath: "/x", opencodeSessionId: nil, worktreePath: nil)
    }

    private func chatWindow(_ index: Int, sid: String) -> MantaWindow {
        MantaWindow(index: index, name: "chat", active: false, paneCurrentPath: "/x", opencodeSessionId: sid, worktreePath: nil)
    }

    private func statusFrame(session: String, windowIndex: Int, running: Bool) -> String {
        #"{"kind":"status","payload":[{"session":"\#(session)","windowIndex":\#(windowIndex),"running":\#(running),"subagents":0}]}"#
    }

    func testStatusFrameDecodesToSingleEntryKeyedProjectHashWindow() {
        let (store, stream) = makeStore()

        stream.inject(#"{"kind":"status","payload":[{"session":"proj","windowIndex":2,"running":true,"subagents":0}]}"#)

        XCTAssertEqual(store.terminalStatus.count, 1)
        XCTAssertEqual(Set(store.terminalStatus.keys), ["proj#2"])
        XCTAssertEqual(store.terminalStatus["proj#2"]?.running, true)
        XCTAssertEqual(store.terminalStatus["proj#2"]?.subagents, 0)
    }

    func testTerminalRowWithRunningPollerEntryIsRunningWithRunningDotAndSubtitle() {
        let (store, stream) = makeStore()
        let w = terminalWindow(2)
        store.applyProjects([project("proj", w)])

        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: true))

        let status = store.rowStatus(for: w)
        XCTAssertTrue(status.isTerminal)
        XCTAssertTrue(status.running)
        XCTAssertEqual(SessionDotState.forRow(status), .running)
        // A running terminal row falls into the running subtitle branch and
        // reads "running" (no model label, so not the "running · model" variant).
        XCTAssertEqual(SessionRowSubtitle.text(for: status), "running")
    }

    func testChatWindowUnaffectedByPollerEntryNamingItsWindowIndex() {
        let (store, stream) = makeStore()
        let w = chatWindow(2, sid: "ses-1")
        store.applyProjects([project("proj", w)])

        // The poller names this chat window's index — it must be ignored; the
        // window's status still comes from the stream (no entry → idle).
        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: true))

        let status = store.rowStatus(for: w)
        XCTAssertFalse(status.isTerminal)
        XCTAssertFalse(status.running)
        XCTAssertEqual(SessionDotState.forRow(status), .idle)
    }

    func testLaterBatchReportingWindowIdleFlipsTerminalRowBack() {
        let (store, stream) = makeStore()
        let w = terminalWindow(2)
        store.applyProjects([project("proj", w)])

        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: true))
        XCTAssertTrue(store.rowStatus(for: w).running)

        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: false))
        let status = store.rowStatus(for: w)
        XCTAssertFalse(status.running)
        XCTAssertEqual(SessionDotState.forRow(status), .idle)
    }

    // MARK: - QuoteText (BET-1353) — ports of chatUtils truncateMiddle / buildQuoteBlock

    func testTruncateMiddleReturnsUnchangedAtAndBelowMax() {
        let atMax = String(repeating: "a", count: QuoteText.max)
        XCTAssertEqual(QuoteText.truncateMiddle(atMax, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail), atMax)
        XCTAssertEqual(QuoteText.truncateMiddle("short", max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail), "short")
    }

    func testTruncateMiddleProducesHeadEllipsisTailAboveMaxAndIsShorter() {
        let text = String(repeating: "x", count: QuoteText.max + 50)
        let out = QuoteText.truncateMiddle(text, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail)
        let expected = String(repeating: "x", count: QuoteText.head) + " \u{2026} " + String(repeating: "x", count: QuoteText.tail)
        XCTAssertEqual(out, expected)
        XCTAssertLessThan(out.count, text.count)
        XCTAssertLessThanOrEqual(out.count, QuoteText.max)
    }

    func testTruncateMiddleUsesSingleU2026WithOneSpaceEachSide() {
        let text = String(repeating: "a", count: QuoteText.max + 10)
        let out = QuoteText.truncateMiddle(text, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail)
        XCTAssertTrue(out.contains(" \u{2026} "))
        XCTAssertEqual(out.components(separatedBy: "\u{2026}").count, 2)
        XCTAssertFalse(out.contains("..."))
    }

    func testTruncateMiddleNeverSplitsACharacter() {
        let emoji = String(repeating: "\u{1F600}", count: QuoteText.max + 20)
        let out = QuoteText.truncateMiddle(emoji, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail)
        // Head + tail of whole grapheme clusters, joined by one " … ".
        XCTAssertEqual(out.count, QuoteText.head + QuoteText.tail + 3)
        XCTAssertTrue(out.allSatisfy { $0 == "\u{1F600}" || $0 == " " || $0 == "\u{2026}" })
    }

    func testBuildQuoteBlockCollapsesWhitespaceAndTrims() {
        XCTAssertEqual(QuoteText.buildQuoteBlock("  hello   world\n\nsecond  line  "), "> hello world second line\n\n")
    }

    func testBuildQuoteBlockNilForEmptyAndWhitespaceOnly() {
        XCTAssertNil(QuoteText.buildQuoteBlock(""))
        XCTAssertNil(QuoteText.buildQuoteBlock("   \n\t  "))
    }

    func testBuildQuoteBlockPrefixesExactlyQuoteAndEndsWithBlankLine() {
        XCTAssertEqual(QuoteText.buildQuoteBlock("hello"), "> hello\n\n")
    }

    func testBuildQuoteBlockReducesLongMultiParagraphToOneLineWithOneEllipsis() {
        let paragraph = Array(repeating: "word ", count: 120).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        let multi = "\(paragraph)\n\n\(paragraph)"
        let out = QuoteText.buildQuoteBlock(multi)!
        XCTAssertEqual(out.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").count, 1)
        XCTAssertEqual(out.components(separatedBy: " \u{2026} ").count, 2)
    }

    func testBuildQuoteBlockEmojiSelectionNeverSplitsACharacter() {
        let selection = String(repeating: "\u{1F600}", count: QuoteText.max + 60)
        let out = QuoteText.buildQuoteBlock(selection)!
        // "> " (2) + head + " … " (3) + tail + "\n\n" (2) = head + tail + 7.
        XCTAssertEqual(out.count, QuoteText.head + QuoteText.tail + 7)
        let body = out.dropFirst(2).dropLast(2)
        XCTAssertTrue(body.allSatisfy { $0 == "\u{1F600}" || $0 == " " || $0 == "\u{2026}" })
    }

    // MARK: - MarkdownBlockSplitter (block-level quoting)
    //
    // The splitter is the pure core of block-level quoting: it cuts an assistant
    // message into top-level blocks, marking the atomic (non-selectable) ones
    // (quotes / fenced code / GFM tables) so MantaProse can give them their own
    // long-press menu. The two invariants every test leans on: block kinds are
    // correctly attributed, and concatenating every block's source reconstructs
    // the original exactly (the round-trip).

    private func blocks(_ markdown: String) -> [MarkdownProseBlock] {
        MarkdownBlockSplitter.split(markdown)
    }

    private func assertRoundTrip(_ markdown: String, file: StaticString = #filePath, line: UInt = #line) {
        let joined = MarkdownBlockSplitter.split(markdown).map(\.source).joined()
        XCTAssertEqual(joined, markdown, "blocks must reconstruct the source exactly", file: file, line: line)
    }

    func testSplitterPlainProseOnlyIsOneProseRun() {
        let source = "First paragraph.\n\nSecond paragraph with **bold** and `code`.\n\n- one\n- two\n"
        let out = blocks(source)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out.first?.kind, .prose)
        XCTAssertEqual(out.first?.source, source)
        assertRoundTrip(source)
    }

    func testSplitterProseOnlyNoTrailingNewline() {
        let source = "just one line"
        let out = blocks(source)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out.first?.kind, .prose)
        assertRoundTrip(source)
    }

    func testSplitterQuoteBetweenTwoParagraphs() {
        let source = "para one\n\n> quoted text\n\npara two"
        let out = blocks(source)
        XCTAssertEqual(out.count, 3)
        XCTAssertEqual(out[0].kind, .prose)
        XCTAssertEqual(out[1].kind, .atomic(.blockQuote))
        XCTAssertTrue(out[1].source.contains("> quoted text"))
        XCTAssertEqual(out[2].kind, .prose)
        assertRoundTrip(source)
    }

    func testSplitterFencedCodeBlock() {
        let source = "intro\n\n```swift\nlet a = 1\n```\n\noutro"
        let out = blocks(source)
        XCTAssertEqual(out.count, 3)
        XCTAssertEqual(out[0].kind, .prose)
        XCTAssertEqual(out[1].kind, .atomic(.codeBlock))
        XCTAssertEqual(out[1].source, "```swift\nlet a = 1\n```\n")
        XCTAssertEqual(out[2].kind, .prose)
        assertRoundTrip(source)
    }

    func testSplitterTildeFencedCodeBlock() {
        let source = "intro\n\n~~~\n> inside a tilde fence\n~~~\n"
        let out = blocks(source)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].kind, .prose)
        XCTAssertEqual(out[1].kind, .atomic(.codeBlock))
        XCTAssertTrue(out[1].source.hasPrefix("~~~"))
        XCTAssertTrue(out[1].source.hasSuffix("~~~\n"))
        assertRoundTrip(source)
    }

    func testSplitterTable() {
        let source = "before\n\n| Latency | On-device |\n|---|---|\n| record | live |\n\nafter"
        let out = blocks(source)
        XCTAssertEqual(out.count, 3)
        XCTAssertEqual(out[0].kind, .prose)
        XCTAssertEqual(out[1].kind, .atomic(.table))
        XCTAssertEqual(out[1].source, "| Latency | On-device |\n|---|---|\n| record | live |\n")
        XCTAssertEqual(out[2].kind, .prose)
        assertRoundTrip(source)
    }

    func testSplitterTableWithAlignmentDelimiter() {
        let source = "| a | b |\n|:---:|:---:|\n| 1 | 2 |"
        let out = blocks(source)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out.first?.kind, .atomic(.table))
        assertRoundTrip(source)
    }

    func testSplitterQuoteLineInsideFenceDoesNotSplit() {
        let source = "```\n> not a quote\n```\n\nafter"
        let out = blocks(source)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].kind, .atomic(.codeBlock))
        XCTAssertTrue(out[0].source.contains("> not a quote"))
        XCTAssertEqual(out[1].kind, .prose)
        XCTAssertFalse(out.contains { $0.kind == .atomic(.blockQuote) })
        assertRoundTrip(source)
    }

    func testSplitterPipeLineInsideFenceDoesNotSplitIntoTable() {
        let source = "```\n| not a table |\n|---|---|\n```\n\nx"
        let out = blocks(source)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].kind, .atomic(.codeBlock))
        XCTAssertTrue(out[0].source.contains("| not a table |"))
        XCTAssertEqual(out[1].kind, .prose)
        XCTAssertFalse(out.contains { $0.kind == .atomic(.table) })
        assertRoundTrip(source)
    }

    func testSplitterConsecutiveQuotesAreOneBlock() {
        let source = "> one\n> two\n\npara"
        let out = blocks(source)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].kind, .atomic(.blockQuote))
        XCTAssertEqual(out[0].source, "> one\n> two\n")
        XCTAssertEqual(out[1].kind, .prose)
        assertRoundTrip(source)
    }

    func testSplitterNestedQuoteStillOneBlock() {
        let source = "> outer\n>> inner\n\npara"
        let out = blocks(source)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].kind, .atomic(.blockQuote))
        XCTAssertEqual(out[0].source, "> outer\n>> inner\n")
        XCTAssertEqual(out[1].kind, .prose)
        assertRoundTrip(source)
    }

    func testSplitterLazyQuoteContinuationBecomesProse() {
        // A non-`>` continuation line following a quote is NOT part of the quote
        // block under this splitter's literal definition (runs of lines starting
        // with up-to-3 spaces then `>`). It becomes prose. This is a documented
        // limitation of the top-level recognizer.
        let source = "> quoted\nlazy continuation\n\npara"
        let out = blocks(source)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].kind, .atomic(.blockQuote))
        XCTAssertEqual(out[0].source, "> quoted\n")
        // The non-`>` continuation and everything after it coalesce into ONE
        // prose run (prose is only broken by an atomic block).
        XCTAssertEqual(out[1].kind, .prose)
        XCTAssertEqual(out[1].source, "lazy continuation\n\npara")
        assertRoundTrip(source)
    }

    func testSplitterEmptyString() {
        XCTAssertEqual(blocks(""), [])
        XCTAssertEqual(blocks("").map(\.source).joined(), "")
    }

    func testSplitterRoundTripPropertyOverFixtures() {
        let fixtures = [
            "First paragraph.\n\nSecond paragraph **bold** `code`.\n\n- one\n- two\n",
            "para one\n\n> quoted text\n\npara two",
            "intro\n\n```swift\nlet a = 1\n```\n\noutro",
            "before\n\n| Latency | On-device |\n|---|---|\n| record | live |\n\nafter",
            "```\n> not a quote\n```\n\nafter",
            "```\n| not a table |\n|---|---|\n```\n\nx",
            "> one\n> two\n\npara",
            "> outer\n>> inner\n\npara",
            "mixed\n\n> a quote\n\n```js\nfunction f() { return 1 }\n```\n\n| c1 | c2 |\n|---|---|\n| v1 | v2 |\n\ntail"
        ]
        for fixture in fixtures {
            assertRoundTrip(fixture)
        }
    }
}
