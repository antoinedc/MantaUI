import XCTest
@testable import MantaUI

// Foundation-only on purpose (no SwiftUI, no stores): these cover the pure
// decisions behind spec §2 (job windows hidden), §3 (Latest-activity ordering)
// and §4 (Background jobs rows). The store-level wiring is in
// BackgroundJobsStoreTests / SessionListJobToleranceTests, which need a Mac.

final class SessionActivityOrderTests: XCTestCase {

    // MARK: - Fixtures

    private func win(_ index: Int, sid: String? = nil, owner: String? = nil, path: String = "", name: String? = nil) -> MantaWindow {
        MantaWindow(index: index, name: name ?? "w\(index)", active: false, paneCurrentPath: path,
                    opencodeSessionId: sid, worktreePath: nil, owner: owner)
    }

    private func proj(_ name: String, cwd: String = "/tmp", _ windows: [MantaWindow]) -> MantaProject {
        MantaProject(tmuxSession: name, defaultCwd: cwd, windows: windows, attached: false, mantaOwned: nil)
    }

    private func job(_ id: String, parent: String?, child: String?, status: String = "running") -> DelegateJob {
        DelegateJob(id: id, parentSessionID: parent, childSessionID: child, status: status)
    }

    private func date(_ seconds: Double) -> Date { Date(timeIntervalSince1970: seconds) }

    private func decodeJobs(_ json: String) throws -> [DelegateJob] {
        try JSONDecoder().decode(LenientDelegateJobs.self, from: Data(json.utf8)).jobs
    }

    // MARK: - MantaWindow.owner

    func testWindowDecodesOwnerTag() throws {
        let json = #"{"index":3,"name":"job-x","active":false,"paneCurrentPath":"/p","opencodeSessionId":"ses_x","worktreePath":null,"owner":"job"}"#
        let w = try JSONDecoder().decode(MantaWindow.self, from: Data(json.utf8))
        XCTAssertEqual(w.owner, "job")
        XCTAssertTrue(w.isJobWindow)
    }

    func testWindowWithoutOwnerIsAUserWindow() throws {
        let json = #"{"index":0,"name":"a","active":false,"paneCurrentPath":"/p"}"#
        let w = try JSONDecoder().decode(MantaWindow.self, from: Data(json.utf8))
        XCTAssertNil(w.owner)
        XCTAssertFalse(w.isJobWindow)
    }

    func testCtoOwnedWindowIsNotAJobWindow() {
        XCTAssertFalse(win(0, owner: "cto").isJobWindow)
        XCTAssertFalse(win(0, owner: "user").isJobWindow)
    }

    // MARK: - DelegateJob decoding

    func testJobDecodesTheFieldsTheSheetShows() throws {
        let json = #"""
        [{"id":"j1","name":"Fix the flaky test","origin":"subagent","branch":"agent/fix","activity":"Running tests",
          "parentSessionID":"ses_p","childSessionID":"ses_c","status":"running",
          "createdAt":1700000000000,"startedAt":1700000005000,"finishedAt":null,"prompt":"ignored"}]
        """#
        let jobs = try decodeJobs(json)
        XCTAssertEqual(jobs.count, 1)
        let j = jobs[0]
        XCTAssertEqual(j.name, "Fix the flaky test")
        XCTAssertEqual(j.origin, "subagent")
        XCTAssertEqual(j.branch, "agent/fix")
        XCTAssertEqual(j.activity, "Running tests")
        XCTAssertEqual(j.createdAt, 1_700_000_000_000)
        XCTAssertEqual(j.startedAt, 1_700_000_005_000)
        XCTAssertNil(j.finishedAt)
        XCTAssertEqual(j.parentSessionID, "ses_p")
        XCTAssertEqual(j.childSessionID, "ses_c")
    }

    func testJobFieldOfTheWrongTypeBecomesNilNotAFailure() throws {
        // `activity` as an object and `branch` as a number must not cost the
        // record — only the field.
        let json = #"[{"id":"j1","status":"running","activity":{"x":1},"branch":7,"startedAt":"1700000005000"}]"#
        let jobs = try decodeJobs(json)
        XCTAssertEqual(jobs.count, 1)
        XCTAssertNil(jobs[0].activity)
        XCTAssertNil(jobs[0].branch)
        // A numeric STRING timestamp is tolerated.
        XCTAssertEqual(jobs[0].startedAt, 1_700_000_005_000)
    }

    func testJobStillBuildsWithTheOriginalFourFieldInitializer() {
        let j = DelegateJob(id: "a", parentSessionID: "p", childSessionID: "c", status: "done")
        XCTAssertNil(j.name)
        XCTAssertNil(j.finishedAt)
        XCTAssertFalse(j.isActive)
    }

    func testStoppableMeansRunningOrPaused() {
        XCTAssertTrue(job("a", parent: nil, child: nil, status: "running").isStoppable)
        XCTAssertTrue(job("a", parent: nil, child: nil, status: "paused").isStoppable)
        XCTAssertFalse(job("a", parent: nil, child: nil, status: "done").isStoppable)
        XCTAssertFalse(job("a", parent: nil, child: nil, status: "failed").isStoppable)
        XCTAssertFalse(job("a", parent: nil, child: nil, status: "stopped").isStoppable)
    }

    // MARK: - Lenient job-list decoding

    func testBareArrayDecodes() throws {
        let jobs = try decodeJobs(#"[{"id":"a","status":"running"},{"id":"b","status":"done"}]"#)
        XCTAssertEqual(jobs.map(\.id), ["a", "b"])
    }

    func testEnvelopeDecodes() throws {
        let jobs = try decodeJobs(#"{"jobs":[{"id":"a","status":"running"}]}"#)
        XCTAssertEqual(jobs.map(\.id), ["a"])
    }

    func testNoEngineEnvelopeIsEmpty() throws {
        XCTAssertEqual(try decodeJobs(#"{"jobs":[]}"#).count, 0)
        XCTAssertEqual(try decodeJobs("[]").count, 0)
    }

    func testOneMalformedRecordIsSkippedNotTheWholeList() throws {
        // Middle record has no id; a non-object and a null are junk too. The
        // good records on either side must survive, in order.
        let json = #"""
        [{"id":"a","status":"running"},
         {"status":"running"},
         "junk",
         null,
         {"id":9,"status":"running"},
         {"id":"b","status":"done"}]
        """#
        XCTAssertEqual(try decodeJobs(json).map(\.id), ["a", "b"])
    }

    func testMalformedRecordInsideEnvelopeIsSkippedToo() throws {
        let json = #"{"jobs":[{"id":"a","status":"running"},{"id":"b"},{"id":"c","status":"failed"}]}"#
        XCTAssertEqual(try decodeJobs(json).map(\.id), ["a", "c"])
    }

    func testObjectWithoutJobsKeyIsEmpty() throws {
        XCTAssertEqual(try decodeJobs(#"{"something":"else"}"#).count, 0)
    }

    // MARK: - Job windows (§2)

    func testOwnerTaggedWindowIsHiddenEvenWithNoJobRecord() {
        // No job list at all (it failed to load): the tag alone hides it.
        let p = proj("proj", [win(0, sid: "ses_a"), win(1, sid: "ses_job", owner: "job")])
        XCTAssertEqual(SessionJobWindows.hiddenIndices(project: p, jobs: []), [1])
    }

    func testOrphanedOwnerTaggedWindowIsHiddenEntirely() {
        // Its parent is in no window of this project: still hidden, never
        // surfaced as a top-level row.
        let p = proj("proj", [win(0, sid: "ses_a"), win(1, sid: "ses_job", owner: "job")])
        let jobs = [job("j", parent: "ses_elsewhere", child: "ses_job")]
        XCTAssertEqual(SessionJobWindows.hiddenIndices(project: p, jobs: jobs), [1])
    }

    func testUntaggedWindowHiddenByTheNestingRuleStillHidden() {
        // Created before the owner tag existed: the job record backstops it.
        let p = proj("proj", [win(0, sid: "ses_parent"), win(1, sid: "ses_child")])
        let jobs = [job("j", parent: "ses_parent", child: "ses_child")]
        XCTAssertEqual(SessionJobWindows.hiddenIndices(project: p, jobs: jobs), [1])
    }

    func testPlainWindowsAreNotHidden() {
        let p = proj("proj", [win(0, sid: "ses_a"), win(1, sid: "ses_b"), win(2)])
        XCTAssertTrue(SessionJobWindows.hiddenIndices(project: p, jobs: []).isEmpty)
    }

    func testUntaggedOrphanWithJobRecordStaysVisible() {
        // The pre-existing "never orphan a reachable session" rule is for an
        // UNTAGGED window: no tag and no visible parent leaves it listed.
        let p = proj("proj", [win(0, sid: "ses_child")])
        let jobs = [job("j", parent: "ses_gone", child: "ses_child")]
        XCTAssertTrue(SessionJobWindows.hiddenIndices(project: p, jobs: jobs).isEmpty)
    }

    func testVisibleRemovesHiddenWindowsAndKeepsTheRest() {
        let p = proj("proj", [win(0), win(1), win(2)])
        let out = SessionJobWindows.visible([p], hidden: ["proj": [1]])
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].windows.map(\.index), [0, 2])
    }

    func testVisibleDropsAProjectWhoseWindowsAreAllJobs() {
        let a = proj("a", [win(0), win(1)])
        let b = proj("b", [win(0, owner: "job")])
        let out = SessionJobWindows.visible([a, b], hidden: ["b": [0]])
        XCTAssertEqual(out.map(\.tmuxSession), ["a"])
    }

    func testVisibleKeepsAProjectThatNeverHadWindows() {
        let empty = proj("empty", [])
        XCTAssertEqual(SessionJobWindows.visible([empty], hidden: [:]).map(\.tmuxSession), ["empty"])
    }

    func testVisibleWithNoHiddenIsIdentity() {
        let a = proj("a", [win(0)]), b = proj("b", [win(0), win(1)])
        XCTAssertEqual(SessionJobWindows.visible([a, b], hidden: [:]), [a, b])
    }

    // MARK: - Latest-activity ordering (§3)

    private func order(_ projects: [MantaProject], _ activity: [String: Double]) -> [String] {
        SessionActivityOrder.flatten(projects) { project, window in
            activity["\(project)#\(window.index)"].map(date)
        }
        .map { "\($0.project)#\($0.window.index)" }
    }

    func testNewestActivityFirstAcrossProjects() {
        let a = proj("a", [win(0, sid: "s1"), win(1, sid: "s2")])
        let b = proj("b", [win(0, sid: "s3")])
        let got = order([a, b], ["a#0": 100, "a#1": 300, "b#0": 200])
        XCTAssertEqual(got, ["a#1", "b#0", "a#0"])
    }

    func testTiesBreakOnProjectOrderThenWindowIndex() {
        let a = proj("a", [win(0, sid: "s1"), win(2, sid: "s2")])
        let b = proj("b", [win(0, sid: "s3"), win(1, sid: "s4")])
        let got = order([a, b], ["a#0": 100, "a#2": 100, "b#0": 100, "b#1": 100])
        XCTAssertEqual(got, ["a#0", "a#2", "b#0", "b#1"])
        // And project order, not name order, decides across projects.
        XCTAssertEqual(order([b, a], ["a#0": 100, "a#2": 100, "b#0": 100, "b#1": 100]),
                       ["b#0", "b#1", "a#0", "a#2"])
    }

    func testTerminalWindowsComeLastByWindowIndex() {
        let a = proj("a", [win(0), win(3, sid: "s1")])           // a#0 terminal
        let b = proj("b", [win(2), win(1, sid: "s2")])           // b#2 terminal
        let got = order([a, b], ["a#3": 50, "b#1": 10])
        XCTAssertEqual(got, ["a#3", "b#1", "a#0", "b#2"])
    }

    func testTerminalTiesBreakOnProjectOrder() {
        let a = proj("a", [win(1)]), b = proj("b", [win(1)])
        XCTAssertEqual(order([a, b], [:]), ["a#1", "b#1"])
        XCTAssertEqual(order([b, a], [:]), ["b#1", "a#1"])
    }

    func testChatWindowsWithUnknownActivityGoAfterKnownAndBeforeTerminals() {
        let a = proj("a", [win(0), win(1, sid: "unknown"), win(2, sid: "known")])
        let got = order([a], ["a#2": 5])
        XCTAssertEqual(got, ["a#2", "a#1", "a#0"])
    }

    func testTerminalIsLastEvenWhenTheClosureReturnsADateForIt() {
        let a = proj("a", [win(0), win(1, sid: "s")])
        XCTAssertEqual(order([a], ["a#0": 999, "a#1": 1]), ["a#1", "a#0"])
    }

    func testOrderDoesNotDependOnTheIncomingWindowOrder() {
        // Pinning reorders windows inside a project before this runs; the flat
        // list must not care.
        let forward = proj("a", [win(0, sid: "s0"), win(1, sid: "s1"), win(2, sid: "s2")])
        let shuffled = proj("a", [win(2, sid: "s2"), win(0, sid: "s0"), win(1, sid: "s1")])
        let activity: [String: Double] = ["a#0": 10, "a#1": 30, "a#2": 20]
        XCTAssertEqual(order([forward], activity), order([shuffled], activity))
        XCTAssertEqual(order([forward], activity), ["a#1", "a#2", "a#0"])
    }

    func testNoWindowsIsEmpty() {
        XCTAssertTrue(order([], [:]).isEmpty)
        XCTAssertTrue(order([proj("a", [])], [:]).isEmpty)
    }

    func testLatestPicksTheLaterInstant() {
        XCTAssertEqual(SessionActivityOrder.latest(date(1), date(2)), date(2))
        XCTAssertEqual(SessionActivityOrder.latest(date(5), date(2)), date(5))
        XCTAssertEqual(SessionActivityOrder.latest(date(5), nil), date(5))
        XCTAssertEqual(SessionActivityOrder.latest(nil, date(2)), date(2))
        XCTAssertNil(SessionActivityOrder.latest(nil, nil))
    }

    // MARK: - Per-directory session fetch (§3)

    func testChatDirectoriesAreDistinctInFirstSeenOrder() {
        let a = proj("a", cwd: "/home/a", [win(0, sid: "s1", path: "/work/x"), win(1, sid: "s2", path: "/work/x"), win(2, sid: "s3", path: "/work/y")])
        let b = proj("b", cwd: "/home/b", [win(0, sid: "s4", path: "/work/y")])
        XCTAssertEqual(SessionActivityOrder.chatDirectories([a, b]), ["/work/x", "/work/y"])
    }

    func testChatDirectoriesFallBackToTheProjectCwd() {
        let a = proj("a", cwd: "/home/a", [win(0, sid: "s1", path: "")])
        XCTAssertEqual(SessionActivityOrder.chatDirectories([a]), ["/home/a"])
    }

    func testChatDirectoriesSkipTerminalWindows() {
        let a = proj("a", cwd: "/home/a", [win(0, sid: nil, path: "/term/dir"), win(1, sid: "", path: "/empty/sid")])
        XCTAssertTrue(SessionActivityOrder.chatDirectories([a]).isEmpty)
    }

    // MARK: - Subtitle with project caption (§3)

    func testSubtitleCarriesTheProjectCaption() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 0, modelLabel: "opus 4.8")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, projectName: "better-ui"), "better-ui · running · opus 4.8")
    }

    func testSubtitleCaptionAloneWhenThereIsNothingElseToSay() {
        let s = SessionRowStatus(running: false, attention: false, backgroundJobs: 0, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s, projectName: "better-ui"), "better-ui")
    }

    func testSubtitleWithoutCaptionIsUnchanged() {
        let s = SessionRowStatus(running: true, attention: false, backgroundJobs: 2, modelLabel: nil)
        XCTAssertEqual(SessionRowSubtitle.text(for: s, projectName: nil), SessionRowSubtitle.text(for: s))
        XCTAssertEqual(SessionRowSubtitle.text(for: s, projectName: ""), "2 background jobs")
        XCTAssertEqual(SessionRowSubtitle.text(for: s, projectName: "p"), "p · 2 background jobs")
    }

    func testOrderingRawValuesAreThePersistedContract() {
        XCTAssertEqual(SessionListOrdering.created.rawValue, "created")
        XCTAssertEqual(SessionListOrdering.activity.rawValue, "activity")
        XCTAssertEqual(SessionListOrdering(rawValue: "activity"), .activity)
        XCTAssertNil(SessionListOrdering(rawValue: "bogus"))
    }

    // MARK: - Background job rows (§4)

    private func ms(_ seconds: Double) -> Double { seconds * 1000 }

    func testRunningJobShowsElapsedSinceItStarted() {
        var j = job("a", parent: nil, child: nil)
        j.startedAt = ms(1000)
        XCTAssertEqual(BackgroundJobFormat.timing(j, now: date(1000 + 4 * 60)), "4m")
        XCTAssertEqual(BackgroundJobFormat.timing(j, now: date(1000 + 45)), "45s")
    }

    func testRunningJobFallsBackToCreatedAt() {
        var j = job("a", parent: nil, child: nil)
        j.createdAt = ms(1000)
        XCTAssertEqual(BackgroundJobFormat.timing(j, now: date(1000 + 3600)), "1h")
    }

    func testFinishedJobShowsWhenItFinished() {
        var j = job("a", parent: nil, child: nil, status: "done")
        j.finishedAt = ms(1000)
        XCTAssertEqual(BackgroundJobFormat.timing(j, now: date(1000 + 12 * 60)), "finished 12m ago")
        XCTAssertEqual(BackgroundJobFormat.timing(j, now: date(1000 + 10)), "finished just now")
    }

    func testNoTimestampMeansNoTimingNotTheDeviceClock() {
        XCTAssertNil(BackgroundJobFormat.timing(job("a", parent: nil, child: nil), now: date(5000)))
        XCTAssertNil(BackgroundJobFormat.timing(job("a", parent: nil, child: nil, status: "failed"), now: date(5000)))
    }

    func testClockSkewNeverShowsANegativeElapsed() {
        var j = job("a", parent: nil, child: nil)
        j.startedAt = ms(2000)
        XCTAssertEqual(BackgroundJobFormat.timing(j, now: date(1000)), "0s")
    }

    func testLiveJobsSortAboveFinishedThenNewestFirst() {
        var old = job("old", parent: nil, child: nil); old.startedAt = ms(1)
        var new = job("new", parent: nil, child: nil); new.startedAt = ms(9)
        var done = job("done", parent: nil, child: nil, status: "done"); done.startedAt = ms(99)
        XCTAssertEqual(BackgroundJobFormat.sorted([done, old, new]).map(\.id), ["new", "old", "done"])
    }

    func testStatusLabelShowsAnUnknownStatusAsTheBoxWroteIt() {
        XCTAssertEqual(BackgroundJobFormat.statusLabel(job("a", parent: nil, child: nil, status: "running")), "running")
        XCTAssertEqual(BackgroundJobFormat.statusLabel(job("a", parent: nil, child: nil, status: "queued")), "queued")
        XCTAssertEqual(BackgroundJobFormat.statusLabel(job("a", parent: nil, child: nil, status: "")), "unknown")
    }

    func testFailureReasonPassesThroughOnlyHumanMessages() {
        XCTAssertEqual(BackgroundJobFormat.failureReason(MantaError.server("job not running")), "job not running")
        XCTAssertEqual(BackgroundJobFormat.failureReason(MantaError.transport("timed out")), "timed out")
        XCTAssertEqual(BackgroundJobFormat.failureReason(MantaError.authRequired), "this device isn't signed in to the box")
        XCTAssertEqual(BackgroundJobFormat.failureReason(MantaError.server("")), "check the connection")
        XCTAssertEqual(BackgroundJobFormat.failureReason(CocoaError(.fileNoSuchFile)), "check the connection")
    }
}
