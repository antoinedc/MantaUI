import XCTest
@testable import MantaUI

// ===========================================================================
// WS05 — the branch / PR store and the review store, driven through their closure
// seams (a fake box). Needs the app target (Combine / os), so this runs on the Mac
// with the rest of MantaUITests; the pure logic is in `GitForgeTests` (verify.sh).
// ===========================================================================

private actor Outage {
    var down = false
    func begin() { down = true }
}

/// A scripted box: records every write and serves whatever `pullRequest` says.
private actor FakeForgeBox {
    var pullRequests: [GitPullRequestResult]
    var merges: [(cwd: String, number: Int, sha: String)] = []
    var ships: [(title: String, body: String)] = []
    var previewCwds: [String] = []
    var previewBranchesSeen: [String] = []
    var shipDelayNanoseconds: UInt64 = 0
    private var pollIndex = 0

    init(_ results: [GitPullRequestResult]) { pullRequests = results }

    func nextPullRequest() -> GitPullRequestResult {
        let result = pullRequests[min(pollIndex, pullRequests.count - 1)]
        pollIndex += 1
        return result
    }

    func recordMerge(_ cwd: String, _ number: Int, _ sha: String) { merges.append((cwd, number, sha)) }
    func recordShip(_ title: String, _ body: String) { ships.append((title, body)) }
    func recordPreview(_ cwd: String) { previewCwds.append(cwd) }
    func setShipDelay(_ ns: UInt64) { shipDelayNanoseconds = ns }
}

@MainActor
final class GitForgeStoreTests: XCTestCase {

    private func pr(_ number: Int, sha: String, can: Bool = true) -> GitPullRequestResult {
        let merge = GitMergeView(can: can, reason: can ? nil : "checks failing", mergeable: GitMergeableLine(text: "mergeable", tone: .ok))
        return GitPullRequestResult(
            pr: GitPullRequest(number: number, title: "PR \(number)", baseRef: "main", headSha: sha),
            checks: [], rollup: .green, stale: false, error: nil, branch: "feat/x", base: "main", aheadCount: 1,
            view: GitPullRequestView(panel: .pr, chipLabel: "feat/x · #\(number)", merge: merge)
        )
    }

    private func noPR(branch: String = "feat/x") -> GitPullRequestResult {
        GitPullRequestResult(
            pr: nil, checks: [], rollup: .none, stale: false, error: nil, branch: branch, base: "main", aheadCount: 2,
            view: GitPullRequestView(panel: .noPR, chipLabel: branch, ship: GitShipView(state: .ready))
        )
    }

    private func client(_ box: FakeForgeBox, mergeResult: GitMergeResult = .ok) -> GitForgeClient {
        GitForgeClient(
            status: { ForgeConnectionStatus(connected: true, login: "ann", kind: "github") },
            pullRequest: { _ in await box.nextPullRequest() },
            shipPreview: { cwd, _, _ in
                await box.recordPreview(cwd)
                return .ok(GitShipPreview(head: "feat/x", base: "main", fileCount: 2, title: "Title", body: "Body"))
            },
            ship: { _, title, body in
                await box.recordShip(title, body)
                let delay = await box.shipDelayNanoseconds
                if delay > 0 { try await Task.sleep(nanoseconds: delay) }
                return .ok(pr: GitPullRequest(number: 5, title: title), url: "https://gh/5")
            },
            merge: { cwd, number, sha in
                await box.recordMerge(cwd, number, sha)
                return mergeResult
            },
            offerDismissed: { false },
            dismissOffer: {}
        )
    }

    func testMergeSendsCapturedTargetAfterPollReplacesPR() async throws {
        let box = FakeForgeBox([pr(1, sha: "a"), pr(2, sha: "b")])
        let store = GitForgeStore(client: client(box))
        store.attach(cwd: "/r")
        await store.refreshNow()
        let target = try XCTUnwrap(store.mergeTarget(), "PR #1 can merge")
        // A poll replaces the PR while the confirmation dialog is open.
        await store.refreshNow()
        XCTAssertEqual(store.state.pr?.number, 2)
        await store.merge(target)
        let merges = await box.merges
        XCTAssertEqual(merges.count, 1)
        XCTAssertEqual(merges.first?.number, 1, "exactly what was confirmed")
        XCTAssertEqual(merges.first?.sha, "a")
        XCTAssertEqual(merges.first?.cwd, "/r")
    }

    func testMergeSendsCapturedTargetAfterPollClearsPR() async throws {
        let box = FakeForgeBox([pr(7, sha: "s7"), noPR()])
        let store = GitForgeStore(client: client(box))
        store.attach(cwd: "/r")
        await store.refreshNow()
        let target = try XCTUnwrap(store.mergeTarget())
        await store.refreshNow()
        XCTAssertNil(store.state.pr)
        XCTAssertNil(store.mergeTarget())
        await store.merge(target)
        let merges = await box.merges
        XCTAssertEqual(merges.first?.number, 7)
        XCTAssertEqual(merges.first?.sha, "s7")
    }

    func testMergeFailureShowsTheBoxMessage() async throws {
        let box = FakeForgeBox([pr(1, sha: "a")])
        let failed = GitMergeResult.failed(GitFailure(error: "blocked", kind: "blocked", message: "Can't merge yet: checks failing"))
        let store = GitForgeStore(client: client(box, mergeResult: failed))
        store.attach(cwd: "/r")
        await store.refreshNow()
        await store.merge(try XCTUnwrap(store.mergeTarget()))
        XCTAssertEqual(store.mergeMessage, .error("Can't merge yet: checks failing"))
        XCTAssertFalse(store.mergeBusy)
    }

    func testMergeTargetNilWhenTheBoxSaysItCannot() async {
        let box = FakeForgeBox([pr(1, sha: "a", can: false)])
        let store = GitForgeStore(client: client(box))
        store.attach(cwd: "/r")
        await store.refreshNow()
        XCTAssertNil(store.mergeTarget())
    }

    func testCreateDisabledWhileBusy() async throws {
        let box = FakeForgeBox([noPR(), pr(5, sha: "n")])
        await box.setShipDelay(150_000_000)
        let store = GitForgeStore(client: client(box))
        store.attach(cwd: "/r")
        await store.refreshNow()
        store.ensureShipPreview(model: nil, sessionId: "ses")
        try await waitUntil { store.shipPreview.canCreate(current: store.currentShipKey) }
        async let first: Void = store.createPullRequest()
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(store.shipBusy)
        XCTAssertTrue(store.isBusy, "the sheet may not close while creating")
        await store.createPullRequest() // a second tap while busy does nothing
        await first
        let ships = await box.ships
        XCTAssertEqual(ships.count, 1)
        XCTAssertEqual(ships.first?.title, "Title")
        XCTAssertFalse(store.shipBusy)
        XCTAssertEqual(store.state.pr?.number, 5, "the sheet swaps to the PR the moment it lands")
        XCTAssertEqual(store.justShipped, 5)
    }

    func testCreatedPRIsShownEvenWhenTheNextPollDoesNotListItYet() async throws {
        // After the ship, GitHub's list still has no PR for the branch.
        let box = FakeForgeBox([noPR(), noPR()])
        let store = GitForgeStore(client: client(box))
        store.attach(cwd: "/r")
        await store.refreshNow()
        store.ensureShipPreview(model: nil, sessionId: nil)
        try await waitUntil { store.shipPreview.canCreate(current: store.currentShipKey) }
        await store.createPullRequest()
        XCTAssertEqual(store.state.pr?.number, 5, "the sheet swaps to the PR immediately")
        XCTAssertEqual(store.justShipped, 5)
        XCTAssertEqual(store.state.view?.panel, .pr)
        // The lagging poll runs and must not take it away.
        await store.refreshNow()
        XCTAssertEqual(store.state.pr?.number, 5)
        XCTAssertEqual(store.state.view?.panel, .pr)
    }

    func testShipPreviewRefetchedAfterBranchChange() async throws {
        let box = FakeForgeBox([noPR(branch: "feat/a"), noPR(branch: "feat/b")])
        let store = GitForgeStore(client: client(box))
        store.attach(cwd: "/r")
        await store.refreshNow()
        store.ensureShipPreview(model: nil, sessionId: nil)
        try await waitUntil { store.shipPreview.key?.branch == "feat/a" && store.shipPreview.canCreate(current: store.currentShipKey) }
        // A terminal-side checkout moves the branch: the old title is dropped and
        // the new branch's preview is fetched while the sheet is open.
        await store.refreshNow()
        XCTAssertEqual(store.state.branch, "feat/b")
        // Wait for the new branch's preview to LAND, not just start loading: the
        // loading state is set before the fetch reaches the box.
        try await waitUntil {
            store.shipPreview.key?.branch == "feat/b" && store.shipPreview.canCreate(current: store.currentShipKey)
        }
        let previews = await box.previewCwds
        XCTAssertEqual(previews.count, 2)
    }

    func testViewlessBoxIsFlaggedForUpdate() async {
        let old = GitPullRequestResult(pr: nil, checks: [], rollup: .none, stale: false, error: nil, branch: "x", base: "main", aheadCount: 1, view: nil)
        let box = FakeForgeBox([old])
        let store = GitForgeStore(client: client(box))
        store.attach(cwd: "/r")
        await store.refreshNow()
        XCTAssertTrue(store.boxNeedsUpdate)
        XCTAssertFalse(store.branchIsInteractive)
    }

    // WS11 D1 review #3: the capability list comes from the app's ONE store; unknown is not "old box".
    func testCapabilityStoreDrivesTheOldBoxFlag() async {
        let withView = noPR()
        let box = FakeForgeBox([withView, withView, withView])
        let store = GitForgeStore(client: client(box))
        let capabilities = BoxCapabilitiesStore(load: { throw MantaError.transport("down") })
        store.useCapabilities(capabilities)
        store.attach(cwd: "/r")
        await store.refreshNow()
        XCTAssertFalse(store.boxNeedsUpdate, "a capability list that could not be read is unknown, not an old box")
        capabilities.apply([])
        XCTAssertTrue(store.boxNeedsUpdate, "the box answered and lacks forge-pr-view-1")
        capabilities.apply(["forge-pr-view-1"])
        XCTAssertFalse(store.boxNeedsUpdate)
    }

    func testAFailedPollKeepsTheLastState() async {
        let box = FakeForgeBox([pr(3, sha: "c")])
        let outage = Outage()
        let base = client(box)
        let flaky = GitForgeClient(
            status: base.status,
            pullRequest: { cwd in
                if await outage.down { throw MantaError.transport("down") }
                return try await base.pullRequest(cwd)
            },
            shipPreview: base.shipPreview, ship: base.ship, merge: base.merge,
            offerDismissed: base.offerDismissed, dismissOffer: base.dismissOffer
        )
        let store = GitForgeStore(client: flaky)
        store.attach(cwd: "/r")
        await store.refreshNow()
        await outage.begin()
        await store.refreshNow()
        XCTAssertEqual(store.state.pr?.number, 3, "the ambient poll never blanks the header")
    }

    // MARK: composer bridge (A.3a)

    func testBridgeNilForReadOnlyJob() {
        let composer = ComposerTextController()
        XCTAssertNotNil(GitComposerBridge.make(readOnly: false, controller: composer))
        XCTAssertNil(GitComposerBridge.make(readOnly: true, controller: composer), "a read-only chat gets no Send to agent")
        XCTAssertNil(GitComposerBridge.make(readOnly: false, controller: nil))
        composer.acceptsInput = false
        XCTAssertNil(GitComposerBridge.make(readOnly: false, controller: composer), "the controller says it takes no input")
    }

    func testBridgeRefusesAfterTurningReadOnly() throws {
        let composer = ComposerTextController()
        let bridge = try XCTUnwrap(GitComposerBridge.make(readOnly: false, controller: composer))
        XCTAssertEqual(bridge.insert("first"), .added)
        XCTAssertEqual(composer.text, "first")
        // The chat resolves to a read-only job while the sheet is still open.
        composer.acceptsInput = false
        XCTAssertEqual(bridge.insert("second"), .readOnly)
        XCTAssertEqual(composer.text, "first", "nothing was inserted")
        composer.acceptsInput = true
        XCTAssertEqual(bridge.insert("third"), .added)
        XCTAssertEqual(composer.text, "first\n\nthird", "append = existing draft + blank line + text")
    }

    // MARK: helper

    private func waitUntil(timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("condition not met in time") }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}

// MARK: - Review store

private actor FakeReviewBox {
    var diffs: [GitDiffResult]
    var diffCalls = 0
    var commentResponses: [GitDraftCommentResult]

    init(diffs: [GitDiffResult], commentResponses: [GitDraftCommentResult] = []) {
        self.diffs = diffs
        self.commentResponses = commentResponses
    }

    func nextDiff() -> GitDiffResult {
        let result = diffs[min(diffCalls, diffs.count - 1)]
        diffCalls += 1
        return result
    }

    func nextComment() -> GitDraftCommentResult { commentResponses.removeFirst() }
}

@MainActor
final class ReviewStoreTests: XCTestCase {

    private func client(_ box: FakeReviewBox) -> ReviewClient {
        ReviewClient(
            diff: { _ in await box.nextDiff() },
            draftComment: { _, _ in await box.nextComment() },
            draftSubmit: { _, _ in .ok },
            threadReply: { _, _, _ in .ok }
        )
    }

    private func file() -> GitDiffFile {
        GitDiffFile(path: "a.ts", added: 1, removed: 0, rowCount: 2, truncated: false, rows: [
            GitDiffRow(kind: .hunk, text: "@@ -0,0 +1,1 @@"),
            GitDiffRow(kind: .added, text: "x", newLine: 1, anchor: GitAnchor(path: "a.ts", line: 1, side: "new")),
        ])
    }

    private let anchor = GitAnchor(path: "a.ts", line: 1, side: "new")

    func testReviewStoreRefetchesDiffOnlyWhenMergeAsks() async {
        let loaded = GitDiffResult(files: [file()], draft: GitDraft(headSha: "h", comments: [GitDraftComment(id: "c1", path: "a.ts", line: 1, body: "one", placement: .row(file: 0, row: 1))]), headSha: "h")
        // Response 1: the add of c2 (one new id, tapped) — no refetch.
        let sameHead = GitDraft(headSha: "h", comments: [GitDraftComment(id: "c1", path: "a.ts", line: 1, body: "one"), GitDraftComment(id: "c2", path: "a.ts", line: 1, body: "two")])
        // Response 2: two unknown ids — refetch.
        let surprise = GitDraft(headSha: "h", comments: [GitDraftComment(id: "c1", path: "a.ts", line: 1, body: "one"), GitDraftComment(id: "x", path: "a.ts", line: 1, body: "x"), GitDraftComment(id: "y", path: "a.ts", line: 1, body: "y")])
        let box = FakeReviewBox(diffs: [loaded], commentResponses: [.ok(sameHead), .ok(surprise)])
        let store = ReviewStore(target: .cwd("/r"), client: client(box))
        await store.load()
        XCTAssertEqual(store.phase, .loaded)
        let initialCalls = await box.diffCalls
        XCTAssertEqual(initialCalls, 1)

        let failure = await store.addComment(anchor: anchor, tapped: .row(file: 0, row: 1), body: "two")
        XCTAssertNil(failure)
        XCTAssertEqual(store.draft?.comments.map(\.id), ["c1", "c2"])
        XCTAssertEqual(store.draft?.comments.last?.placement, .row(file: 0, row: 1))
        let afterAdd = await box.diffCalls
        XCTAssertEqual(afterAdd, 1, "a plain add does not refetch the diff")

        _ = await store.addComment(anchor: anchor, tapped: .row(file: 0, row: 1), body: "three")
        let afterSurprise = await box.diffCalls
        XCTAssertEqual(afterSurprise, 2, "unknown ids ask for exactly one refetch")
    }

    func testReviewStateParseFailedBeatsEmpty() async {
        let thread = GitThread(id: "t1", path: "a.ts", line: 1, comments: [GitThreadComment(author: "bob", body: "hi")], placement: .unplaced)
        let result = GitDiffResult(files: [], threads: [thread], draft: nil, message: "Couldn't read this diff.", parseFailed: true)
        let store = ReviewStore(target: .cwd("/r"), client: client(FakeReviewBox(diffs: [result])))
        await store.load()
        XCTAssertEqual(store.phase, .parseFailed("Couldn't read this diff."), "never `empty` for a parse failure")
        XCTAssertEqual(store.notes.unplacedThreads.map(\.id), ["t1"], "the thread is still reachable")
    }

    func testReviewErrorStatePrecedesEverything() async {
        let result = GitDiffResult(files: [], error: "no_pr", message: "No pull request on this session's branch.", parseFailed: true)
        let store = ReviewStore(target: .cwd("/r"), client: client(FakeReviewBox(diffs: [result])))
        await store.load()
        XCTAssertEqual(store.phase, .error("No pull request on this session's branch."))
    }

    func testReviewBoxWithoutFilesIsTooOld() async {
        let store = ReviewStore(target: .cwd("/r"), client: client(FakeReviewBox(diffs: [GitDiffResult(files: nil)])))
        await store.load()
        XCTAssertEqual(store.phase, .boxTooOld)
    }

    func testRemoveAfterRemoteClearReturnsNullClearsPendingBar() async {
        let loaded = GitDiffResult(files: [file()], draft: GitDraft(headSha: "h", comments: [GitDraftComment(id: "c1", path: "a.ts", line: 1, body: "one", placement: .row(file: 0, row: 1))]), headSha: "h")
        // Another client already submitted the draft: the delete answers ok with no draft.
        let box = FakeReviewBox(diffs: [loaded], commentResponses: [.ok(nil)])
        let store = ReviewStore(target: .cwd("/r"), client: client(box))
        await store.load()
        XCTAssertTrue(store.showsPendingBar)
        await store.removeComment(id: "c1")
        XCTAssertNil(store.draft)
        XCTAssertFalse(store.showsPendingBar, "no cards, no bar")
        XCTAssertNil(store.banner, "and no error")
        let calls = await box.diffCalls
        XCTAssertEqual(calls, 1, "no refetch")
    }

    func testRateLimitedReloadKeepsTheSnapshotAndTheDraft() async {
        let loaded = GitDiffResult(files: [file()], draft: GitDraft(headSha: "h", comments: [GitDraftComment(id: "c1", path: "a.ts", line: 1, body: "one", placement: .row(file: 0, row: 1))]), headSha: "h")
        // The forge is rate-limited: no files, stale, and the box still returns the stored draft (unplaced).
        let limited = GitDiffResult(files: [], draft: GitDraft(headSha: "h", comments: [GitDraftComment(id: "c1", path: "a.ts", line: 1, body: "one", placement: .unplaced)]), stale: true)
        let box = FakeReviewBox(diffs: [loaded, limited])
        let store = ReviewStore(target: .cwd("/r"), client: client(box))
        await store.load()
        await store.load()
        XCTAssertEqual(store.phase, .loaded, "never 'No diff.'")
        XCTAssertEqual(store.files.count, 1)
        XCTAssertTrue(store.diffIsStale, "the footnote shows")
        XCTAssertTrue(store.showsPendingBar, "the pending bar stays")
        XCTAssertEqual(store.pendingCount, 1)
        XCTAssertEqual(store.draft?.comments.first?.placement, .row(file: 0, row: 1), "the placement it had is kept")
    }

    func testFailedRemoveShowsOnTheCardNotTheBanner() async {
        let loaded = GitDiffResult(files: [file()], draft: GitDraft(headSha: "h", comments: [GitDraftComment(id: "c1", path: "a.ts", line: 1, body: "one", placement: .row(file: 0, row: 1))]), headSha: "h")
        let box = FakeReviewBox(diffs: [loaded], commentResponses: [.failed(GitFailure(error: "comment not found", message: "That comment was already removed."))])
        let store = ReviewStore(target: .cwd("/r"), client: client(box))
        await store.load()
        await store.removeComment(id: "c1")
        XCTAssertEqual(store.noteErrors["c1"], "That comment was already removed.")
        XCTAssertNil(store.banner)
        XCTAssertEqual(store.pendingCount, 1, "the card stays")
    }

    func testFailedAddKeepsTheTextAndSurfacesTheBoxMessage() async {
        let loaded = GitDiffResult(files: [file()], headSha: "h")
        let box = FakeReviewBox(diffs: [loaded], commentResponses: [.failed(GitFailure(error: "invalid comment anchor", message: "That line can't take a comment."))])
        let store = ReviewStore(target: .cwd("/r"), client: client(box))
        await store.load()
        let failure = await store.addComment(anchor: anchor, tapped: .row(file: 0, row: 1), body: "x")
        XCTAssertEqual(failure, "That line can't take a comment.")
        XCTAssertNil(store.draft)
        let blank = await store.addComment(anchor: anchor, tapped: .row(file: 0, row: 1), body: "   ")
        XCTAssertEqual(blank, "Write a comment first.")
    }
}
