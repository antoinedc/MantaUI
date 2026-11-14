import XCTest
@testable import MantaUI

// Background job progress (spec 2026-11-14 §5.3 / B4 / B6): lenient `view`
// decoding, the rev rule, the client clock and the strings the rows and the
// detail sheet show. Foundation only, so it runs in the Linux package view too.

final class BackgroundJobProgressTests: XCTestCase {

    // MARK: - Fixtures

    private static let fullJob = #"""
    {"id":"j1","status":"running","name":"Refactor","view":{
      "rev":{"epoch":1000,"n":3},"asOf":1000030000,"state":"working",
      "headline":"Running tests","headlineSource":"model",
      "steps":{"done":3,"total":7,"current":"Run tests",
        "items":[{"text":"Plan","status":"done"},{"text":"Run tests","status":"current"},{"text":"Ship","status":"pending"}],
        "source":"checklist","planRevision":2,"grewAt":1000020000},
      "bar":0.42,
      "live":{"tool":"bash","target":"npm test","startedAt":1000025000},
      "startedAt":999900000,"endedAt":null,"lastProgressAt":1000000000,"ceilingAt":1003000000,
      "milestones":[{"at":1000010000,"text":"Found the cause"},{"at":999950000,"text":"Started"}],
      "files":{"changed":3},
      "usage":{"tokens":12400,"costUsd":0.4,"costPartial":true},
      "model":"opus 4.8"}}
    """#

    private func decodeJob(_ json: String) throws -> DelegateJob {
        try JSONDecoder().decode(DelegateJob.self, from: Data(json.utf8))
    }

    private func decodeView(_ json: String) -> DelegateJobProgressView? {
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else { return nil }
        return DelegateJobProgressView(json: value)
    }

    private func view(
        rev: (Double, Double) = (1, 1),
        asOf: Double = 0,
        state: DelegateJobProgressView.State = .working,
        headline: String = "",
        steps: DelegateJobProgressView.Steps? = nil,
        live: DelegateJobProgressView.Live? = nil,
        startedAt: Double? = nil,
        endedAt: Double? = nil,
        lastProgressAt: Double? = nil,
        ceilingAt: Double? = nil
    ) -> DelegateJobProgressView {
        DelegateJobProgressView(
            rev: .init(epoch: rev.0, n: rev.1),
            asOf: asOf,
            state: state,
            headline: headline,
            steps: steps,
            live: live,
            startedAt: startedAt,
            endedAt: endedAt,
            lastProgressAt: lastProgressAt,
            ceilingAt: ceilingAt
        )
    }

    private func job(_ id: String, status: String = "running", view: DelegateJobProgressView? = nil) -> DelegateJob {
        DelegateJob(id: id, status: status, view: view)
    }

    // MARK: - Decoding

    func testFullViewDecodes() throws {
        let v = try XCTUnwrap(decodeJob(Self.fullJob).view)
        XCTAssertEqual(v.rev, .init(epoch: 1000, n: 3))
        XCTAssertEqual(v.asOf, 1_000_030_000)
        XCTAssertEqual(v.state, .working)
        XCTAssertEqual(v.headline, "Running tests")
        XCTAssertEqual(v.steps?.done, 3)
        XCTAssertEqual(v.steps?.total, 7)
        XCTAssertEqual(v.steps?.current, "Run tests")
        XCTAssertEqual(v.steps?.items.map(\.status), [.done, .current, .pending])
        XCTAssertEqual(v.steps?.grewAt, 1_000_020_000)
        XCTAssertEqual(v.bar, 0.42)
        XCTAssertEqual(v.live, DelegateJobProgressView.Live(tool: "bash", target: "npm test", startedAt: 1_000_025_000))
        XCTAssertEqual(v.startedAt, 999_900_000)
        XCTAssertNil(v.endedAt)
        XCTAssertEqual(v.lastProgressAt, 1_000_000_000)
        XCTAssertEqual(v.ceilingAt, 1_003_000_000)
        XCTAssertEqual(v.milestones.map(\.text), ["Found the cause", "Started"])
        XCTAssertEqual(v.files, DelegateJobProgressView.Files(changed: 3))
        XCTAssertEqual(v.usage, DelegateJobProgressView.Usage(tokens: 12400, costUsd: 0.4, costPartial: true))
        XCTAssertEqual(v.model, "opus 4.8")
        XCTAssertTrue(v.isRunning)
    }

    func testPartialViewDecodesWithDefaults() throws {
        let j = try decodeJob(#"{"id":"j","status":"running","view":{"rev":{"epoch":1,"n":0},"asOf":5,"state":"paused"}}"#)
        let v = try XCTUnwrap(j.view)
        XCTAssertEqual(v.state, .paused)
        XCTAssertEqual(v.headline, "")
        XCTAssertNil(v.steps)
        XCTAssertNil(v.bar)
        XCTAssertNil(v.live)
        XCTAssertNil(v.startedAt)
        XCTAssertNil(v.ceilingAt)
        XCTAssertEqual(v.milestones, [])
        XCTAssertNil(v.files)
        XCTAssertNil(v.usage)
        XCTAssertNil(v.model)
    }

    func testAbsentViewIsNilAndTheRecordStillDecodes() throws {
        let j = try decodeJob(#"{"id":"j","status":"running","name":"Old box","activity":"editing"}"#)
        XCTAssertNil(j.view)
        XCTAssertEqual(j.name, "Old box")
        XCTAssertEqual(j.activity, "editing")
    }

    func testInvalidTypedViewIsNilAndNeverDropsTheJob() throws {
        for bad in [
            #""oops""#, "42", "[]", "null",
            #"{"asOf":5,"state":"working"}"#,                                          // no rev
            #"{"rev":{"epoch":"x","n":1},"asOf":5,"state":"working"}"#,                // rev of the wrong type
            #"{"rev":{"epoch":1,"n":1},"state":"working"}"#,                           // no asOf
            #"{"rev":{"epoch":1,"n":1},"asOf":"5","state":"working"}"#,                // asOf of the wrong type
            #"{"rev":{"epoch":1,"n":1},"asOf":5,"state":"daydreaming"}"#,              // a state this build doesn't know
            #"{"rev":{"epoch":1,"n":1},"asOf":5,"state":7}"#,
        ] {
            let j = try decodeJob(#"{"id":"j","status":"running","name":"N","view":"# + bad + "}")
            XCTAssertNil(j.view, "view \(bad) must decode to nil")
            XCTAssertEqual(j.id, "j")
            XCTAssertEqual(j.name, "N")
        }
    }

    func testWronglyTypedFieldsDropOutWithoutLosingTheView() throws {
        let v = try XCTUnwrap(decodeView(#"""
        {"rev":{"epoch":1,"n":1},"asOf":5,"state":"working",
         "headline":5,"steps":{"done":"x","total":4},"bar":"half","live":{"tool":"bash"},
         "startedAt":"soon","milestones":"none","files":[],"usage":{"tokens":"many"},"model":3}
        """#))
        XCTAssertEqual(v.headline, "")
        XCTAssertNil(v.steps)
        XCTAssertNil(v.bar)
        XCTAssertNil(v.live)
        XCTAssertNil(v.startedAt)
        XCTAssertEqual(v.milestones, [])
        XCTAssertNil(v.files)
        XCTAssertNil(v.usage)
        XCTAssertNil(v.model)
    }

    func testStepsNeedAPositiveTotalAndClampDone() throws {
        XCTAssertNil(try XCTUnwrap(decodeView(#"{"rev":{"epoch":1,"n":1},"asOf":5,"state":"working","steps":{"done":0,"total":0}}"#)).steps)
        let v = try XCTUnwrap(decodeView(#"{"rev":{"epoch":1,"n":1},"asOf":5,"state":"working","steps":{"done":9,"total":4}}"#))
        XCTAssertEqual(v.steps?.done, 4)
        XCTAssertEqual(v.steps?.items, [])
    }

    func testBadListEntriesAreSkippedNotFatal() throws {
        let v = try XCTUnwrap(decodeView(#"""
        {"rev":{"epoch":1,"n":1},"asOf":5,"state":"working",
         "steps":{"done":1,"total":3,"items":[{"text":"ok","status":"done"},{"text":"x","status":"weird"},{"status":"done"},{"text":"  ","status":"done"}]},
         "milestones":[{"at":1,"text":"good"},{"at":"1","text":"bad"},{"at":2},{"at":3,"text":""}]}
        """#))
        XCTAssertEqual(v.steps?.items.map(\.text), ["ok"])
        XCTAssertEqual(v.milestones.map(\.text), ["good"])
    }

    func testFilesObjectWithNullCountIsUnknownNotAbsent() throws {
        let v = try XCTUnwrap(decodeView(#"{"rev":{"epoch":1,"n":1},"asOf":5,"state":"working","files":{"changed":null}}"#))
        XCTAssertEqual(v.files, DelegateJobProgressView.Files(changed: nil))
        XCTAssertNil(BackgroundJobProgressFormat.filesChanged(v.files))
    }

    func testBarIsClamped() throws {
        XCTAssertEqual(try XCTUnwrap(decodeView(#"{"rev":{"epoch":1,"n":1},"asOf":5,"state":"working","bar":3}"#)).bar, 1)
        XCTAssertEqual(try XCTUnwrap(decodeView(#"{"rev":{"epoch":1,"n":1},"asOf":5,"state":"working","bar":-1}"#)).bar, 0)
    }

    func testModelTextIsPlainSingleLineAndTruncated() throws {
        let long = String(repeating: "x", count: 300)
        let v = try XCTUnwrap(decodeView(#"""
        {"rev":{"epoch":1,"n":1},"asOf":5,"state":"working",
         "headline":"**bold** <b>html</b> [link](http://x)\nsecond line",
         "milestones":[{"at":1,"text":"\#(long)"}]}
        """#))
        XCTAssertEqual(v.headline, "**bold** <b>html</b> [link](http://x)", "markup stays literal; only the first line is kept")
        XCTAssertEqual(v.milestones.first?.text.count, 160)
        XCTAssertTrue(v.milestones.first?.text.hasSuffix("…") ?? false)
    }

    func testListSkipsNoRecordBecauseOfABadView() throws {
        let json = #"[{"id":"a","status":"running","view":"junk"},{"id":"b","status":"running"}]"#
        let jobs = try JSONDecoder().decode(LenientDelegateJobs.self, from: Data(json.utf8)).jobs
        XCTAssertEqual(jobs.map(\.id), ["a", "b"])
        XCTAssertNil(jobs[0].view)
    }

    func testViewSurvivesAnEncodeDecodeRoundTripOfTheJob() throws {
        let original = try decodeJob(Self.fullJob)
        let data = try JSONEncoder().encode(original)
        XCTAssertEqual(try JSONDecoder().decode(DelegateJob.self, from: data), original)
    }

    // MARK: - Rev rule

    func testRevIsNewerByEpochThenCounter() {
        typealias Rev = DelegateJobProgressView.Rev
        XCTAssertTrue(Rev(epoch: 2, n: 0).isNewer(than: Rev(epoch: 1, n: 99)), "a new epoch always wins")
        XCTAssertTrue(Rev(epoch: 1, n: 5).isNewer(than: Rev(epoch: 1, n: 4)))
        XCTAssertFalse(Rev(epoch: 1, n: 5).isNewer(than: Rev(epoch: 1, n: 5)), "the same rev is not applied twice")
        XCTAssertFalse(Rev(epoch: 1, n: 4).isNewer(than: Rev(epoch: 1, n: 5)))
        XCTAssertFalse(Rev(epoch: 1, n: 99).isNewer(than: Rev(epoch: 2, n: 0)), "a retired epoch is dropped")
    }

    func testPatchAppliesANewerViewInPlaceWithoutARefetch() {
        let jobs = [job("a", view: view(rev: (1, 1), headline: "old")), job("b")]
        let update = BackgroundJobUpdate(id: "a", status: "running", activity: "editing", view: view(rev: (1, 2), headline: "new"))
        let patched = BackgroundJobViewMerge.patch(jobs, with: update)
        XCTAssertEqual(patched.jobs[0].view?.headline, "new")
        XCTAssertEqual(patched.jobs[0].activity, "editing")
        XCTAssertEqual(patched.jobs[1], jobs[1])
        XCTAssertEqual(patched.appliedID, "a")
        XCTAssertFalse(patched.needsRefetch)
    }

    func testPatchIgnoresAnOlderOrEqualRev() {
        let jobs = [job("a", view: view(rev: (1, 5), headline: "newest"))]
        for stale in [view(rev: (1, 4), headline: "stale"), view(rev: (1, 5), headline: "twin"), view(rev: (0, 99), headline: "dead epoch")] {
            let patched = BackgroundJobViewMerge.patch(jobs, with: BackgroundJobUpdate(id: "a", status: "running", view: stale))
            XCTAssertEqual(patched.jobs, jobs)
            XCTAssertNil(patched.appliedID)
            XCTAssertFalse(patched.needsRefetch)
        }
    }

    func testPatchAcceptsANewEpochEvenWithALowerCounter() {
        let jobs = [job("a", view: view(rev: (1, 50), headline: "before restart"))]
        let patched = BackgroundJobViewMerge.patch(jobs, with: BackgroundJobUpdate(id: "a", status: "running", view: view(rev: (2, 0), headline: "after restart")))
        XCTAssertEqual(patched.jobs[0].view?.headline, "after restart")
    }

    func testPatchAsksForARefetchForAnUnknownIdAChangedStatusOrNoView() {
        let jobs = [job("a", view: view(rev: (1, 1)))]
        XCTAssertTrue(BackgroundJobViewMerge.patch(jobs, with: BackgroundJobUpdate(id: "zzz", status: "running", view: view(rev: (1, 9)))).needsRefetch)
        XCTAssertTrue(BackgroundJobViewMerge.patch(jobs, with: BackgroundJobUpdate(id: nil, status: nil)).needsRefetch)
        XCTAssertTrue(BackgroundJobViewMerge.patch(jobs, with: BackgroundJobUpdate(id: "a", status: "running")).needsRefetch, "an older box sends no view: refetch as before")
        let done = BackgroundJobViewMerge.patch(jobs, with: BackgroundJobUpdate(id: "a", status: "done", view: view(rev: (1, 2), state: .done)))
        XCTAssertTrue(done.needsRefetch, "a status change may re-nest the job")
        XCTAssertEqual(done.jobs[0].view?.state, .done, "the view is still patched in")
    }

    func testListMergeKeepsAViewTheFetchDoesNotBeat() {
        let existing = [job("a", view: view(rev: (1, 5), headline: "newest")), job("b", view: view(rev: (1, 1), headline: "old"))]
        let fetched = [
            job("a", view: view(rev: (1, 4), headline: "late list response")),
            job("b", view: view(rev: (1, 2), headline: "fresh")),
            job("c", view: view(rev: (1, 1), headline: "new job")),
        ]
        let merged = BackgroundJobViewMerge.merge(existing: existing, fetched: fetched)
        XCTAssertEqual(merged.jobs.map { $0.view?.headline }, ["newest", "fresh", "new job"])
        XCTAssertEqual(merged.applied, ["b", "c"])
    }

    func testListMergeTakesAFetchedJobWithNoView() {
        let existing = [job("a", view: view(rev: (1, 5)))]
        let merged = BackgroundJobViewMerge.merge(existing: existing, fetched: [job("a", status: "done")])
        XCTAssertNil(merged.jobs[0].view)
        XCTAssertEqual(merged.jobs[0].status, "done")
        XCTAssertTrue(merged.applied.isEmpty)
    }

    func testUpdatePayloadParses() throws {
        let payload = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"id":"j1","status":"running","activity":"editing","view":{"rev":{"epoch":1,"n":2},"asOf":9,"state":"needs-decision","headline":"Which branch?"}}
        """#.utf8))
        let update = BackgroundJobUpdate(payload: payload)
        XCTAssertEqual(update.id, "j1")
        XCTAssertEqual(update.status, "running")
        XCTAssertEqual(update.activity, "editing")
        XCTAssertEqual(update.view?.state, .needsDecision)

        let legacy = BackgroundJobUpdate(payload: try JSONDecoder().decode(JSONValue.self, from: Data(#"{"id":"j1","status":"paused"}"#.utf8)))
        XCTAssertNil(legacy.view)
        XCTAssertNil(BackgroundJobUpdate(payload: nil).id)
    }

    // MARK: - Client clock (§5.3)

    // The local clock reads 1 000 000 s; the box is 30 s ahead of it.
    private let localNow = Date(timeIntervalSince1970: 1_000_000)
    private var boxNow: Double { 1_000_030_000 }
    private var clock: JobViewClock { JobViewClock(asOf: boxNow, localNow: localNow) }

    func testSkewComesFromAsOf() {
        XCTAssertEqual(clock.skewMs, 30_000)
        XCTAssertEqual(clock.boxNowMs(localNow), boxNow)
        XCTAssertEqual(clock.boxNowMs(localNow.addingTimeInterval(10)), boxNow + 10_000)
    }

    func testElapsedTicksWhileRunningAndFreezesAtEnd() {
        let running = view(startedAt: boxNow - 125_000)
        let at = { (seconds: Double) in
            running.elapsedMs(self.clock, now: self.localNow.addingTimeInterval(seconds)).map(BackgroundJobProgressFormat.duration(ms:))
        }
        XCTAssertEqual(at(0), "2m")
        XCTAssertEqual(at(60), "3m")

        let finished = view(state: .done, startedAt: boxNow - 900_000, endedAt: boxNow - 300_000)
        XCTAssertEqual(finished.elapsedMs(clock, now: localNow), 600_000)
        XCTAssertEqual(finished.elapsedMs(clock, now: localNow.addingTimeInterval(3600)), 600_000, "frozen at endedAt")
        XCTAssertNil(view().elapsedMs(clock, now: localNow), "no startedAt, no elapsed")
    }

    func testQuietShowsOnlyWhileRunningAndFromThreeMinutes() {
        XCTAssertNil(view(lastProgressAt: boxNow - 179_999).quietMs(clock, now: localNow))
        XCTAssertEqual(view(lastProgressAt: boxNow - 180_000).quietMs(clock, now: localNow), 180_000)
        // The client clock keeps counting with no new view.
        XCTAssertEqual(view(lastProgressAt: boxNow - 150_000).quietMs(clock, now: localNow.addingTimeInterval(40)), 190_000)
        XCTAssertNil(view(state: .paused, endedAt: boxNow, lastProgressAt: boxNow - 600_000).quietMs(clock, now: localNow))
        XCTAssertNil(view(lastProgressAt: nil).quietMs(clock, now: localNow))
        XCTAssertEqual(view(state: .needsDecision, lastProgressAt: boxNow - 200_000).quietMs(clock, now: localNow), 200_000)
    }

    func testTimeLeftShowsInTheLastThirtyMinutesAndClampsAtZero() {
        XCTAssertNil(view(ceilingAt: boxNow + 30 * 60_000).timeLeftMs(clock, now: localNow), "not yet inside the window")
        XCTAssertEqual(view(ceilingAt: boxNow + 29 * 60_000).timeLeftMs(clock, now: localNow), 29 * 60_000)
        let v = view(ceilingAt: boxNow + 20_000)
        XCTAssertEqual(v.timeLeftMs(clock, now: localNow.addingTimeInterval(5)), 15_000)
        XCTAssertEqual(v.timeLeftMs(clock, now: localNow.addingTimeInterval(500)), 0, "clamps at 0")
        XCTAssertNil(view(state: .done, endedAt: boxNow, ceilingAt: boxNow + 60_000).timeLeftMs(clock, now: localNow))
        XCTAssertNil(view(ceilingAt: nil).timeLeftMs(clock, now: localNow), "opencode-owned: no ceiling")
    }

    func testPlanGrewLastsTwoMinutes() {
        func grew(_ ago: Double) -> DelegateJobProgressView {
            view(steps: .init(done: 1, total: 4, grewAt: boxNow - ago))
        }
        XCTAssertTrue(grew(119_000).planGrew(clock, now: localNow))
        XCTAssertFalse(grew(120_000).planGrew(clock, now: localNow))
        XCTAssertTrue(grew(100_000).planGrew(clock, now: localNow.addingTimeInterval(10)))
        XCTAssertFalse(grew(100_000).planGrew(clock, now: localNow.addingTimeInterval(30)))
        XCTAssertFalse(view(steps: .init(done: 1, total: 4)).planGrew(clock, now: localNow))
        XCTAssertFalse(view().planGrew(clock, now: localNow))
    }

    func testToolAge() {
        let v = view(live: .init(tool: "bash", target: "npm test", startedAt: boxNow - 65_000))
        XCTAssertEqual(v.toolAgeMs(clock, now: localNow), 65_000)
        XCTAssertNil(view().toolAgeMs(clock, now: localNow))
    }

    func testDetailBundlesTheDerivedText() throws {
        let v = try XCTUnwrap(try decodeJob(Self.fullJob).view)
        // box-now = asOf: started 130 s ago, last progress 30 s ago, ceiling 2 970 s away.
        let detail = BackgroundJobProgressDetail(view: v, clock: clock, now: localNow)
        XCTAssertEqual(detail.elapsed, "2m")
        XCTAssertNil(detail.quiet)
        XCTAssertNil(detail.timeLeft, "49 min left is outside the 30 min window")
        XCTAssertEqual(detail.tool, "bash: npm test · 5s")
        XCTAssertTrue(detail.planGrew)
        XCTAssertEqual(detail.files, "3 files changed")
        XCTAssertEqual(detail.usage, "12.4k tokens · $0.40+")
        XCTAssertEqual(detail.milestones.map(\.text), ["Found the cause", "Started"])
        XCTAssertEqual(detail.milestones.map(\.ago), ["just now", "1m ago"])

        let later = BackgroundJobProgressDetail(view: v, clock: clock, now: localNow.addingTimeInterval(40 * 60))
        XCTAssertEqual(later.quiet, "Quiet for 40m")
        XCTAssertEqual(later.timeLeft, "9m", "9 min left, now inside the window")
        XCTAssertFalse(later.planGrew)
    }

    // MARK: - Text

    func testChipAndBar() {
        let steps = DelegateJobProgressView.Steps(done: 3, total: 7)
        XCTAssertEqual(BackgroundJobProgressFormat.chip(steps), "3/7")
        XCTAssertEqual(BackgroundJobProgressFormat.barFraction(view(steps: steps)) ?? -1, 3.0 / 7.0, accuracy: 0.0001)
        var withBar = view(steps: steps)
        withBar.bar = 0.9
        XCTAssertEqual(BackgroundJobProgressFormat.barFraction(withBar), 0.9)
        XCTAssertNil(BackgroundJobProgressFormat.barFraction(view()), "no steps, no bar")
    }

    func testHeadlineLine() {
        typealias HeadlineLine = BackgroundJobProgressFormat.HeadlineLine
        XCTAssertNil(BackgroundJobProgressFormat.headlineLine(view()), "nothing to say: the row falls back to activity")
        XCTAssertEqual(BackgroundJobProgressFormat.headlineLine(view(headline: "Running tests")),
                       HeadlineLine(text: "Running tests", needsDecision: false))
        XCTAssertEqual(BackgroundJobProgressFormat.headlineLine(view(state: .needsDecision, headline: "Which branch?")),
                       HeadlineLine(text: "Needs a decision: Which branch?", needsDecision: true))
        XCTAssertEqual(BackgroundJobProgressFormat.headlineLine(view(state: .needsDecision)),
                       HeadlineLine(text: "Needs a decision", needsDecision: true))
        // A job that ENDED blocked is `needs-decision` too (endedAt set).
        let ended = view(state: .needsDecision, headline: "Which branch?", endedAt: 5)
        XCTAssertFalse(ended.isRunning)
        XCTAssertEqual(BackgroundJobProgressFormat.headlineLine(ended)?.needsDecision, true)
    }

    func testUsageAndFilesText() {
        typealias Usage = DelegateJobProgressView.Usage
        XCTAssertEqual(BackgroundJobProgressFormat.usage(Usage(tokens: 812)), "812 tokens")
        XCTAssertEqual(BackgroundJobProgressFormat.usage(Usage(tokens: 12400, costUsd: 0.4, costPartial: false)), "12.4k tokens · $0.40")
        XCTAssertEqual(BackgroundJobProgressFormat.usage(Usage(tokens: 0, costUsd: 0.004)), "<$0.01")
        XCTAssertNil(BackgroundJobProgressFormat.usage(Usage(tokens: 0)))
        XCTAssertNil(BackgroundJobProgressFormat.usage(nil))
        XCTAssertEqual(BackgroundJobProgressFormat.filesChanged(DelegateJobProgressView.Files(changed: 1)), "1 file changed")
        XCTAssertEqual(BackgroundJobProgressFormat.filesChanged(DelegateJobProgressView.Files(changed: 0)), "0 files changed")
        XCTAssertNil(BackgroundJobProgressFormat.filesChanged(nil))
    }

    func testAgoWording() {
        XCTAssertEqual(BackgroundJobProgressFormat.ago(ms: 10_000), "just now")
        XCTAssertEqual(BackgroundJobProgressFormat.ago(ms: 5 * 60_000), "5m ago")
        XCTAssertEqual(BackgroundJobProgressFormat.ago(ms: -5_000), "just now", "skew can put an anchor slightly in the future")
    }
}
