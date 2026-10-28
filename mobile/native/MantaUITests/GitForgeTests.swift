import XCTest
@testable import MantaUI

/// WS05 — decoding the box's forge views, plus the KEEP-CLIENT logic (connect
/// offer, merge snapshot, ship-preview sequencing, composer policy, draft
/// reconciliation). The rules themselves (order, tone, gate, copy, placement)
/// are the box's and are tested in `src/server/forge/*.test.mjs`. Pure — runs
/// under `verify.sh`.
final class GitForgeTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: pull-request view

    private let prJSON = #"""
    {
      "pr": { "number": 412, "title": "Fix the thing", "url": "https://gh/pr/412", "state": "open",
              "headRef": "feat/x", "baseRef": "main", "headSha": "abc123", "reviewers": ["ann"],
              "mergeable": true, "mergeBlockedReason": null, "unresolvedThreads": 0 },
      "checks": [
        { "name": "build", "status": "completed", "conclusion": "failure", "url": "https://ci/b", "tone": "error" },
        { "name": "lint", "status": "in_progress", "tone": "running" },
        { "name": "test", "status": "completed", "conclusion": "success", "tone": "ok" }
      ],
      "rollup": "red", "stale": false, "error": null, "branch": "feat/x", "base": "main", "aheadCount": 2,
      "view": {
        "panel": "pr", "chipLabel": "feat/x · #412",
        "ship": { "state": "has-pr", "copy": null },
        "merge": { "can": false, "reason": "checks failing", "mergeable": { "text": "mergeable", "tone": "ok" } },
        "checks": {
          "counts": { "passed": 1, "failed": 1, "running": 1 },
          "chip": { "glyph": "✗", "label": "✗ 1 failed", "tone": "danger" },
          "failuresPrompt": "Checks are failing on this pull request:\n- build (https://ci/b)\n\nPlease investigate and fix them.",
          "logsUrl": "https://ci/b"
        }
      }
    }
    """#

    func testDecodePullRequestViewFull() throws {
        let r = try decode(GitPullRequestResult.self, prJSON)
        XCTAssertEqual(r.pr?.number, 412)
        XCTAssertEqual(r.pr?.headSha, "abc123")
        XCTAssertEqual(r.pr?.reviewers, ["ann"])
        XCTAssertEqual(r.pr?.mergeable, true)
        XCTAssertEqual(r.rollup, .red)
        XCTAssertEqual(r.aheadCount, 2)
        let view = try XCTUnwrap(r.view)
        XCTAssertEqual(view.panel, .pr)
        XCTAssertTrue(view.panel.isInteractive)
        XCTAssertEqual(view.chipLabel, "feat/x · #412")
        XCTAssertEqual(view.ship.state, .hasPR)
        XCTAssertNil(view.ship.copy)
        XCTAssertEqual(view.merge?.can, false)
        XCTAssertEqual(view.merge?.reason, "checks failing")
        XCTAssertEqual(view.merge?.mergeable, GitMergeableLine(text: "mergeable", tone: .ok))
        XCTAssertEqual(view.checks.counts, GitChecksCounts(passed: 1, failed: 1, running: 1))
    }

    func testDecodeViewMissingIsNil() throws {
        let r = try decode(GitPullRequestResult.self, #"{ "pr": null, "checks": [], "rollup": "none", "stale": false, "error": null, "branch": "x", "base": "main", "aheadCount": 1 }"#)
        XCTAssertNil(r.view, "a box without the capability sends no view")
        XCTAssertNil(r.pr)
        XCTAssertEqual(r.rollup, GitRollup.none)
        XCTAssertEqual(r.branch, "x")
    }

    func testDecodeUnknownPanelAndToneKept() throws {
        let r = try decode(GitPullRequestResult.self, #"""
        { "pr": null, "checks": [ { "name": "a", "tone": "sparkly" } ], "rollup": "purple", "branch": "x",
          "view": { "panel": "teleport", "ship": { "state": "warp" }, "checks": { "chip": { "glyph": "?", "label": "?", "tone": "odd" } } } }
        """#)
        XCTAssertEqual(r.view?.panel, .other("teleport"))
        XCTAssertFalse(r.view?.panel.isInteractive ?? true, "an unknown panel renders as a plain label")
        XCTAssertEqual(r.view?.ship.state, .other("warp"))
        XCTAssertEqual(r.checks.first?.tone, .other("sparkly"))
        XCTAssertEqual(r.view?.checks.chip?.tone, .other("odd"))
        XCTAssertEqual(r.rollup, GitRollup.none, "an unknown rollup is none")
    }

    func testDecodeChecksKeepServerOrderAndTone() throws {
        let r = try decode(GitPullRequestResult.self, prJSON)
        XCTAssertEqual(r.checks.map(\.name), ["build", "lint", "test"], "the box's order is kept, never re-sorted")
        XCTAssertEqual(r.checks.map(\.tone), [.error, .running, .ok])
        XCTAssertEqual(r.checks[0].rawState, "failure")
        XCTAssertEqual(r.checks[1].rawState, "in_progress")
        XCTAssertEqual(r.checks[0].url, "https://ci/b")
    }

    func testDecodeChecksChipNilWhenAbsent() throws {
        let r = try decode(GitPullRequestResult.self, #"{ "pr": { "number": 1 }, "checks": [], "rollup": "none", "view": { "panel": "pr", "checks": { "counts": { "passed": 0, "failed": 0, "running": 0 }, "chip": null, "failuresPrompt": null, "logsUrl": null } } }"#)
        XCTAssertNil(r.view?.checks.chip)
        XCTAssertNil(r.view?.checks.failuresPrompt)
        XCTAssertNil(r.view?.checks.logsUrl)
    }

    func testDecodeFailuresPromptAndLogsUrl() throws {
        let r = try decode(GitPullRequestResult.self, prJSON)
        XCTAssertEqual(
            r.view?.checks.failuresPrompt,
            "Checks are failing on this pull request:\n- build (https://ci/b)\n\nPlease investigate and fix them."
        )
        XCTAssertEqual(r.view?.checks.logsUrl, "https://ci/b")
        XCTAssertEqual(r.view?.checks.chip?.label, "✗ 1 failed")
    }

    func testDecodeMergeableNullMeansComputing() throws {
        let pr = try decode(GitPullRequest.self, #"{ "number": 3, "mergeable": null }"#)
        XCTAssertNil(pr.mergeable)
        let t = try decode(GitPullRequest.self, #"{ "number": 3, "mergeable": true }"#)
        XCTAssertEqual(t.mergeable, true)
    }

    func testDecodeToleratesMissingFieldsAndNumericDoubles() throws {
        let pr = try decode(GitPullRequest.self, #"{ "number": 7.0 }"#)
        XCTAssertEqual(pr.number, 7)
        XCTAssertEqual(pr.reviewers, [])
        XCTAssertEqual(pr.unresolvedThreads, 0)
        XCTAssertEqual(pr.state, "open")
    }

    // MARK: write results

    func testDecodeMergeFailureMessage() throws {
        let failed = try decode(GitMergeResult.self, #"{ "ok": false, "error": "blocked", "kind": "blocked", "message": "Can't merge yet: checks failing" }"#)
        guard case .failed(let failure) = failed else { return XCTFail("expected failed") }
        XCTAssertEqual(failure.kind, "blocked")
        XCTAssertEqual(failure.message, "Can't merge yet: checks failing")
        XCTAssertEqual(failure.display, "Can't merge yet: checks failing")

        let oldBox = try decode(GitMergeResult.self, #"{ "ok": false, "error": "head sha moved", "kind": "sha_mismatch" }"#)
        guard case .failed(let raw) = oldBox else { return XCTFail("expected failed") }
        XCTAssertEqual(raw.display, "head sha moved", "without a message the raw error is shown")

        XCTAssertEqual(try decode(GitMergeResult.self, #"{ "ok": true, "data": {} }"#), .ok)
    }

    func testDecodeShipFailureMessage() throws {
        let failed = try decode(GitShipResult.self, #"{ "ok": false, "error": "no_forge", "message": "This folder isn't linked to a GitHub repository." }"#)
        guard case .failed(let failure) = failed else { return XCTFail("expected failed") }
        XCTAssertEqual(failure.display, "This folder isn't linked to a GitHub repository.")

        let ok = try decode(GitShipResult.self, #"{ "ok": true, "pr": { "number": 9, "url": "https://gh/9" }, "url": "https://gh/9" }"#)
        XCTAssertEqual(ok, .ok(pr: GitPullRequest(number: 9, url: "https://gh/9"), url: "https://gh/9"))

        let preview = try decode(GitShipPreviewResult.self, #"{ "ok": true, "head": "feat/x", "base": "main", "fileCount": 3, "title": "T", "body": "B" }"#)
        XCTAssertEqual(preview, .ok(GitShipPreview(head: "feat/x", base: "main", fileCount: 3, title: "T", body: "B")))
        let previewFail = try decode(GitShipPreviewResult.self, #"{ "ok": false, "error": "unknown_base", "message": "Couldn't tell which branch to target." }"#)
        XCTAssertEqual(previewFail, .failed(GitFailure(error: "unknown_base", message: "Couldn't tell which branch to target.")))
    }

    func testDecodeReviewFailureMessage() throws {
        let submit = try decode(GitDraftSubmitResult.self, #"{ "ok": false, "error": "x", "kind": "http_422", "message": "GitHub rejected the review — a comment may point at a line that's no longer in the pull request. Your comments are kept." }"#)
        guard case .failed(let f) = submit else { return XCTFail("expected failed") }
        XCTAssertEqual(f.kind, "http_422")
        XCTAssertTrue(f.display.hasPrefix("GitHub rejected the review"))
        let reply = try decode(GitThreadReplyResult.self, #"{ "ok": false, "error": "empty reply", "message": "Write a reply first." }"#)
        XCTAssertEqual(reply, .failed(GitFailure(error: "empty reply", message: "Write a reply first.")))
        XCTAssertEqual(try decode(GitThreadReplyResult.self, #"{ "ok": true, "message": null }"#), .ok)
    }

    // MARK: connect offer

    func testConnectOfferShouldShow() {
        XCTAssertTrue(GitConnectOffer.shouldShow(connected: false, forgeKind: "github", dismissed: false))
        XCTAssertFalse(GitConnectOffer.shouldShow(connected: true, forgeKind: "github", dismissed: false))
        XCTAssertFalse(GitConnectOffer.shouldShow(connected: false, forgeKind: "github", dismissed: true))
        XCTAssertFalse(GitConnectOffer.shouldShow(connected: false, forgeKind: nil, dismissed: false))
    }

    func testStateCopiesFieldsAndKindIsNilForNoForge() throws {
        let r = try decode(GitPullRequestResult.self, prJSON)
        let s = GitForgeState(status: ForgeConnectionStatus(connected: true, login: "ann", kind: "github"), result: r)
        XCTAssertTrue(s.connected)
        XCTAssertEqual(s.kind, "github")
        XCTAssertEqual(s.pr?.number, 412)
        XCTAssertEqual(s.branch, "feat/x")
        XCTAssertEqual(s.view?.panel, .pr)

        let noForge = GitForgeState(status: ForgeConnectionStatus(connected: true), result: GitPullRequestResult(error: "no_forge"))
        XCTAssertNil(noForge.kind)
        XCTAssertTrue(noForge.boxLacksPullRequestView, "connected but no view = an older box")
        XCTAssertFalse(s.boxLacksPullRequestView)
    }

    // MARK: merge snapshot

    private func state(pr: GitPullRequest?, can: Bool?) -> GitForgeState {
        let merge = can.map { GitMergeView(can: $0, reason: $0 ? nil : "checks failing", mergeable: GitMergeableLine(text: "mergeable", tone: .ok)) }
        let view = GitPullRequestView(panel: .pr, merge: merge)
        return GitForgeState(connected: true, kind: "github", pr: pr, checks: [], stale: false, branch: "feat/x",
                             base: "main", aheadCount: 1, view: view, error: nil)
    }

    func testMergeTargetNilWithoutPRAndWhenBoxSaysCannot() {
        XCTAssertNil(GitMergeTarget.target(state: state(pr: nil, can: nil), cwd: "/r"))
        let pr = GitPullRequest(number: 9, title: "T", baseRef: "main", headSha: "sha9")
        XCTAssertNil(GitMergeTarget.target(state: state(pr: pr, can: false), cwd: "/r"))
        XCTAssertNil(GitMergeTarget.target(state: state(pr: pr, can: nil), cwd: "/r"), "no merge view = no merge")
    }

    func testMergeTargetCapturesHeadSha() throws {
        let pr = GitPullRequest(number: 9, title: "T", baseRef: "main", headSha: "sha9")
        let target = try XCTUnwrap(GitMergeTarget.target(state: state(pr: pr, can: true), cwd: "/r"))
        XCTAssertEqual(target, GitMergeTarget(cwd: "/r", number: 9, title: "T", base: "main", headSha: "sha9"))
        // A later poll with another PR does not change what was captured.
        let later = GitPullRequest(number: 10, title: "U", baseRef: "main", headSha: "sha10")
        _ = GitMergeTarget.target(state: state(pr: later, can: true), cwd: "/r")
        XCTAssertEqual(target.number, 9)
        XCTAssertEqual(target.headSha, "sha9")
    }

    // MARK: ship preview sequencing

    private let keyA = GitShipKey(cwd: "/r", branch: "feat/a", base: "main")
    private let keyB = GitShipKey(cwd: "/r", branch: "feat/b", base: "main")

    private func preview(_ title: String = "T", head: String = "feat/a") -> GitShipPreview {
        GitShipPreview(head: head, base: "main", fileCount: 2, title: title, body: "B")
    }

    func testShipPreviewDiscardsLateResponseForOldBranch() {
        // The user switched to feat/b while feat/a's preview was drafting.
        XCTAssertNil(GitShipPreviewState.accept(response: .ok(preview()), for: keyA, current: keyB))
        XCTAssertNil(GitShipPreviewState.accept(response: .ok(preview()), for: keyA, current: nil))
        XCTAssertEqual(GitShipPreviewState.accept(response: .ok(preview()), for: keyA, current: keyA), .ready(keyA, preview()))
        XCTAssertEqual(
            GitShipPreviewState.accept(response: .failed(GitFailure(error: "x", message: "Couldn't push")), for: keyA, current: keyA),
            .failed(keyA, "Couldn't push")
        )
    }

    func testShipPreviewInvalidatedBySameCwdBranchSwitch() {
        let ready = GitShipPreviewState.ready(keyA, preview())
        XCTAssertEqual(ready.invalidated(by: keyB), .idle, "a branch switch in the same folder drops the old title")
        XCTAssertEqual(ready.invalidated(by: keyA), ready)
        XCTAssertEqual(ready.invalidated(by: nil), .idle)
        XCTAssertEqual(GitShipPreviewState.idle.invalidated(by: keyB), .idle)
        XCTAssertEqual(GitShipPreviewState.loading(keyA).invalidated(by: GitShipKey(cwd: "/r", branch: "feat/a", base: "develop")), .idle)
    }

    func testCanCreateFalseUntilPreviewMatchesCurrentBranch() {
        XCTAssertFalse(GitShipPreviewState.idle.canCreate(current: keyA))
        XCTAssertFalse(GitShipPreviewState.loading(keyA).canCreate(current: keyA))
        XCTAssertFalse(GitShipPreviewState.failed(keyA, "no").canCreate(current: keyA))
        XCTAssertFalse(GitShipPreviewState.ready(keyA, preview()).canCreate(current: keyB), "a preview of another branch")
        XCTAssertFalse(GitShipPreviewState.ready(keyA, preview()).canCreate(current: nil))
        XCTAssertTrue(GitShipPreviewState.ready(keyA, preview()).canCreate(current: keyA))
    }

    func testPreviewTitleFallsBackToHead() {
        XCTAssertEqual(preview("  ", head: "feat/a").effectiveTitle, "feat/a")
        XCTAssertEqual(preview("", head: "feat/a").effectiveTitle, "feat/a")
        XCTAssertEqual(preview("Add x", head: "feat/a").effectiveTitle, "Add x")
        XCTAssertTrue(GitShipPreviewState.ready(keyA, preview("")).canCreate(current: keyA), "the branch name stands in")
    }

    func testShipPreviewCoversTheKeyItIsFetchingOrHolds() {
        XCTAssertTrue(GitShipPreviewState.loading(keyA).covers(keyA))
        XCTAssertTrue(GitShipPreviewState.ready(keyA, preview()).covers(keyA))
        XCTAssertFalse(GitShipPreviewState.loading(keyA).covers(keyB))
        XCTAssertFalse(GitShipPreviewState.failed(keyA, "x").covers(keyA), "a failed preview is re-fetched on demand")
        XCTAssertFalse(GitShipPreviewState.idle.covers(keyA))
    }

    func testShipKeyNeedsABranch() {
        let none = GitForgeState.empty
        XCTAssertNil(GitShipKey.current(state: none, cwd: "/r"))
        var s = GitForgeState.empty
        s.branch = "feat/a"
        s.base = "main"
        XCTAssertEqual(GitShipKey.current(state: s, cwd: "/r"), keyA)
    }

    // MARK: composer policy

    func testCanInsertPolicyTruthTable() {
        for readOnly in [false, true] {
            for hasController in [false, true] {
                for accepts in [false, true] {
                    let expected = !readOnly && hasController && accepts
                    XCTAssertEqual(
                        GitComposerPolicy.canInsert(readOnly: readOnly, hasController: hasController, acceptsInput: accepts),
                        expected,
                        "readOnly=\(readOnly) controller=\(hasController) accepts=\(accepts)"
                    )
                }
            }
        }
    }

    func testSendResultMessages() {
        XCTAssertNil(GitSendResult.added.failureMessage)
        XCTAssertEqual(GitSendResult.readOnly.failureMessage, "This chat is read-only.")
        XCTAssertEqual(GitSendResult.rejected.failureMessage, "Couldn't add it to your message.")
    }

    // MARK: session lookup

    func testSessionLookupFindsPaneDirectoryThenProjectRoot() {
        let projects = [
            MantaProject(tmuxSession: "p", defaultCwd: "/root", windows: [
                MantaWindow(index: 0, name: "a", active: true, paneCurrentPath: "/root/wt", opencodeSessionId: "ses_1", worktreePath: nil),
                MantaWindow(index: 1, name: "b", active: false, paneCurrentPath: "", opencodeSessionId: "ses_2", worktreePath: nil),
            ], attached: false, mantaOwned: nil)
        ]
        XCTAssertEqual(GitSessionLookup.cwd(for: "ses_1", in: projects), "/root/wt")
        XCTAssertEqual(GitSessionLookup.cwd(for: "ses_2", in: projects), "/root")
        XCTAssertNil(GitSessionLookup.cwd(for: "ses_gone", in: projects))
        XCTAssertNil(GitSessionLookup.cwd(for: "", in: projects))
    }

    // MARK: review wire

    private let diffJSON = #"""
    {
      "diff": "raw", "headSha": "h1", "stale": false, "error": null, "message": null, "parseFailed": false,
      "files": [
        { "path": "src/a.ts", "added": 2, "removed": 1, "rowCount": 4, "truncated": false, "rows": [
          { "kind": "hunk", "text": "@@ -1,2 +1,3 @@", "oldLine": null, "newLine": null, "anchor": null },
          { "kind": "context", "text": "first", "oldLine": 1, "newLine": 1, "anchor": { "path": "src/a.ts", "line": 1, "side": "both" } },
          { "kind": "added", "text": "+++ heading", "oldLine": null, "newLine": 2, "anchor": { "path": "src/a.ts", "line": 2, "side": "new" } },
          { "kind": "removed", "text": "gone", "oldLine": 2, "newLine": null, "anchor": { "path": "src/a.ts", "line": 2, "side": "old" } }
        ] }
      ],
      "threads": [
        { "id": "t1", "path": "src/a.ts", "line": 1, "side": "LEFT", "resolved": true,
          "comments": [ { "author": "bob", "body": "hmm", "createdAt": "2026-10-01T10:00:00Z" } ],
          "placement": { "at": "row", "file": 0, "row": 1 } },
        { "id": "t2", "path": "gone.ts", "line": 3, "side": "RIGHT", "resolved": false, "comments": [], "placement": { "at": "unplaced" } }
      ],
      "draft": { "headSha": "h1", "verdict": "commented", "body": "", "stale": false, "updatedAt": 5,
        "comments": [ { "id": "c1", "path": "src/a.ts", "line": 2, "side": "new", "body": "nit", "placement": { "at": "row", "file": 0, "row": 2 } } ] }
    }
    """#

    func testDecodeDiffFilesRowsAnchors() throws {
        let r = try decode(GitDiffResult.self, diffJSON)
        let files = try XCTUnwrap(r.files)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0].path, "src/a.ts")
        XCTAssertEqual(files[0].rows.map(\.kind), [.hunk, .context, .added, .removed])
        XCTAssertNil(files[0].rows[0].anchor, "a hunk header is not commentable")
        XCTAssertEqual(files[0].rows[2].text, "+++ heading", "header-like content is content")
        XCTAssertEqual(files[0].rows[2].anchor, GitAnchor(path: "src/a.ts", line: 2, side: "new"))
        XCTAssertEqual(files[0].rows[3].anchor, GitAnchor(path: "src/a.ts", line: 2, side: "old"))
        XCTAssertEqual(files[0].rows[1].oldLine, 1)
        XCTAssertEqual(files[0].rows[1].newLine, 1)
        XCTAssertEqual(r.headSha, "h1")
        XCTAssertFalse(r.parseFailed)
    }

    func testDecodePlacementVariantsAndUnknownAt() throws {
        XCTAssertEqual(try decode(GitPlacement.self, #"{ "at": "row", "file": 2, "row": 7 }"#), .row(file: 2, row: 7))
        XCTAssertEqual(try decode(GitPlacement.self, #"{ "at": "file", "file": 3 }"#), .file(3))
        XCTAssertEqual(try decode(GitPlacement.self, #"{ "at": "unplaced" }"#), .unplaced)
        XCTAssertEqual(try decode(GitPlacement.self, #"{ "at": "orbit", "file": 1 }"#), .unplaced, "an unknown placement is never dropped")
        XCTAssertEqual(try decode(GitPlacement.self, #"{ "at": "row", "file": 1 }"#), .unplaced, "a row without its row is unplaced")
        let r = try decode(GitDiffResult.self, diffJSON)
        XCTAssertEqual(r.threads.map(\.placement), [.row(file: 0, row: 1), .unplaced])
        XCTAssertEqual(r.threads[0].attribution, "bob · resolved")
        XCTAssertEqual(r.threads[0].comments.first?.createdAt, "2026-10-01T10:00:00Z")
    }

    func testDecodeTruncatedFile() throws {
        let r = try decode(GitDiffResult.self, #"{ "files": [ { "path": "big.ts", "added": 5000, "removed": 0, "rowCount": 5001, "truncated": true, "rows": [] } ], "threads": [], "draft": null }"#)
        let file = try XCTUnwrap(r.files?.first)
        XCTAssertTrue(file.truncated)
        XCTAssertEqual(file.rowCount, 5001)
        XCTAssertTrue(file.rows.isEmpty)
    }

    func testDecodeDiffWithoutFilesIsOldBox() throws {
        let r = try decode(GitDiffResult.self, #"{ "diff": "raw text", "threads": [], "headSha": "h", "error": null }"#)
        XCTAssertNil(r.files, "no `files` = a box without the structured diff")
        XCTAssertNil(r.draft)
    }

    func testDecodeDraftWithPlacedComments() throws {
        let r = try decode(GitDiffResult.self, diffJSON)
        let draft = try XCTUnwrap(r.draft)
        XCTAssertEqual(draft.verdict, .commented)
        XCTAssertEqual(draft.headSha, "h1")
        XCTAssertFalse(draft.stale)
        XCTAssertEqual(draft.comments, [GitDraftComment(id: "c1", path: "src/a.ts", line: 2, side: "new", body: "nit", placement: .row(file: 0, row: 2))])
    }

    func testDecodeParseFailedFlag() throws {
        let r = try decode(GitDiffResult.self, #"{ "files": [], "threads": [ { "id": "t", "placement": { "at": "unplaced" } } ], "draft": null, "error": null, "parseFailed": true, "message": "Couldn't read this diff." }"#)
        XCTAssertTrue(r.parseFailed)
        XCTAssertNil(r.error, "the forge fetch worked")
        XCTAssertEqual(r.message, "Couldn't read this diff.")
        XCTAssertEqual(r.files?.count, 0)
        XCTAssertEqual(r.threads.count, 1)
    }

    func testDecodeDiffErrorKeepsTheBoxMessage() throws {
        let r = try decode(GitDiffResult.self, #"{ "files": [], "threads": [], "error": "no_pr", "message": "No pull request on this session's branch." }"#)
        XCTAssertEqual(r.error, "no_pr")
        XCTAssertEqual(r.message, "No pull request on this session's branch.")
    }

    func testDraftOpsEncodeTheirPayloads() {
        let add = GitDraftOp.add(path: "a.ts", line: 3, side: "new", body: "x").json
        XCTAssertEqual(add["op"] as? String, "add")
        let comment = add["comment"] as? [String: Any]
        XCTAssertEqual(comment?["path"] as? String, "a.ts")
        XCTAssertEqual(comment?["line"] as? Int, 3)
        XCTAssertEqual(comment?["side"] as? String, "new")
        XCTAssertEqual(comment?["body"] as? String, "x")
        XCTAssertEqual(GitDraftOp.delete(id: "c1").json["op"] as? String, "delete")
        XCTAssertEqual((GitDraftOp.delete(id: "c1").json["comment"] as? [String: String])?["id"], "c1")
        XCTAssertEqual(GitDraftOp.setVerdict(.approved).json["verdict"] as? String, "approved")
        XCTAssertTrue(GitDraftOp.setVerdict(nil).json["verdict"] is NSNull)
        XCTAssertEqual(GitRef.cwd("/r").json["cwd"] as? String, "/r")
        XCTAssertEqual(GitRef.pr(repoKey: "h/o/r", number: 4).json["repoKey"] as? String, "h/o/r")
        XCTAssertEqual(GitRef.pr(repoKey: "h/o/r", number: 4).json["number"] as? Int, 4)
    }

    func testPendingLabel() {
        XCTAssertEqual(ReviewCopy.pendingLabel(1), "1 comment")
        XCTAssertEqual(ReviewCopy.pendingLabel(2), "2 comments")
        XCTAssertEqual(ReviewCopy.pendingLabel(0), "0 comments")
    }

    func testVerdictTitlesAndWireValues() {
        XCTAssertEqual(GitVerdict.allCases.map(\.title), ["Approve", "Request changes", "Comment"])
        XCTAssertEqual(GitVerdict.allCases.map(\.rawValue), ["approved", "changes_requested", "commented"])
    }

    // MARK: draft reconcile

    private func comment(_ id: String, _ placement: GitPlacement? = nil) -> GitDraftComment {
        GitDraftComment(id: id, path: "a.ts", line: 1, side: "new", body: id, placement: placement)
    }

    private func draft(_ comments: [GitDraftComment], head: String = "h1", stale: Bool = false,
                       verdict: GitVerdict? = nil) -> GitDraft {
        GitDraft(headSha: head, verdict: verdict, body: "", comments: comments, stale: stale)
    }

    func testDraftMergeAddKeepsExistingAndPlacesNewAtTap() throws {
        let previous = draft([comment("c1", .row(file: 0, row: 1)), comment("c2", .row(file: 1, row: 4))])
        let response = draft([comment("c1"), comment("c2"), comment("c3")])
        let result = ReviewDraftMerge.merge(previous: previous, response: response, tapped: .row(file: 2, row: 9))
        XCTAssertFalse(result.needsRefetch)
        let placed = try XCTUnwrap(result.draft)
        XCTAssertEqual(placed.comments.map(\.id), ["c1", "c2", "c3"])
        XCTAssertEqual(placed.comments.map(\.placement), [.row(file: 0, row: 1), .row(file: 1, row: 4), .row(file: 2, row: 9)])
    }

    func testDraftMergeFirstCommentWithNoPreviousDraft() throws {
        let result = ReviewDraftMerge.merge(previous: nil, response: draft([comment("c1")]), tapped: .row(file: 0, row: 3))
        XCTAssertFalse(result.needsRefetch)
        XCTAssertEqual(result.draft?.comments.first?.placement, .row(file: 0, row: 3))
    }

    func testDraftMergeDeleteRemovesOnlyThatId() throws {
        let previous = draft([comment("c1", .row(file: 0, row: 1)), comment("c2", .row(file: 1, row: 4))])
        let result = ReviewDraftMerge.merge(previous: previous, response: draft([comment("c2")]), tapped: nil)
        XCTAssertFalse(result.needsRefetch)
        XCTAssertEqual(result.draft?.comments.map(\.id), ["c2"])
        XCTAssertEqual(result.draft?.comments.first?.placement, .row(file: 1, row: 4))
    }

    func testDraftMergeVerdictKeepsAllPlacements() throws {
        let previous = draft([comment("c1", .file(0)), comment("c2", .unplaced)])
        let result = ReviewDraftMerge.merge(previous: previous, response: draft([comment("c1"), comment("c2")], verdict: .approved), tapped: nil)
        XCTAssertFalse(result.needsRefetch)
        XCTAssertEqual(result.draft?.verdict, .approved, "non-comment fields come from the response")
        XCTAssertEqual(result.draft?.comments.map(\.placement), [.file(0), .unplaced])
    }

    func testDraftMergeUnknownIdsOrHeadChangeRequestsRefetch() throws {
        let previous = draft([comment("c1", .row(file: 0, row: 1))])
        // Two unknown ids (another device added comments).
        let many = ReviewDraftMerge.merge(previous: previous, response: draft([comment("c1"), comment("c8"), comment("c9")]), tapped: .row(file: 0, row: 5))
        XCTAssertTrue(many.needsRefetch)
        XCTAssertEqual(many.draft?.comments.first?.placement, .row(file: 0, row: 1), "known comments keep their place")
        // One unknown id but nothing tapped (not an add by this user).
        let stranger = ReviewDraftMerge.merge(previous: previous, response: draft([comment("c1"), comment("c8")]), tapped: nil)
        XCTAssertTrue(stranger.needsRefetch)
        XCTAssertEqual(stranger.draft?.comments.last?.placement, .unplaced)
        // The head moved under the draft.
        let moved = ReviewDraftMerge.merge(previous: previous, response: draft([comment("c1")], head: "h2"), tapped: nil)
        XCTAssertTrue(moved.needsRefetch)
        let flipped = ReviewDraftMerge.merge(previous: previous, response: draft([comment("c1")], stale: true), tapped: nil)
        XCTAssertTrue(flipped.needsRefetch)
        XCTAssertTrue(flipped.draft?.stale ?? false)
    }

    func testDraftMergeNullResponseClearsDraftWithoutRefetch() {
        let previous = draft([comment("c1", .row(file: 0, row: 1))])
        let result = ReviewDraftMerge.merge(previous: previous, response: nil, tapped: nil)
        XCTAssertNil(result.draft)
        XCTAssertFalse(result.needsRefetch)
    }

    // MARK: note index

    func testNoteIndexGroupsByPlacementWithDeterministicRowIDs() throws {
        let r = try decode(GitDiffResult.self, diffJSON)
        let index = ReviewNoteIndex(threads: r.threads, draft: r.draft)
        XCTAssertEqual(ReviewNoteIndex.rowID(file: 0, row: 1), "0:1")
        XCTAssertEqual(index.rowThreads["0:1"]?.map(\.id), ["t1"])
        XCTAssertEqual(index.rowDrafts["0:2"]?.map(\.id), ["c1"])
        XCTAssertEqual(index.unplacedThreads.map(\.id), ["t2"])
        XCTAssertTrue(index.hasUnplaced)
        XCTAssertFalse(ReviewNoteIndex(threads: [], draft: nil).hasUnplaced)
    }

    // MARK: a just-created PR stays on screen

    func testPinningShowsThePRViewImmediately() {
        var s = GitForgeState.empty
        s.branch = "feat/x"
        s.view = GitPullRequestView(panel: .noPR, ship: GitShipView(state: .ready))
        let pr = GitPullRequest(number: 5, title: "T", headRef: "feat/x", baseRef: "main", headSha: "s5")
        let pinned = s.pinning(pr)
        XCTAssertEqual(pinned.pr?.number, 5)
        XCTAssertEqual(pinned.view?.panel, .pr)
        XCTAssertEqual(pinned.view?.chipLabel, "feat/x · #5")
        XCTAssertEqual(pinned.view?.ship.state, .hasPR)
        XCTAssertNil(pinned.view?.merge, "the gate arrives with the next poll")
    }

    func testPinIsKeptUntilAPollReturnsThePROrTheBranchMoves() {
        let pr = GitPullRequest(number: 5, headRef: "feat/x")
        let pin = GitPinnedPR(pr: pr, branch: "feat/x")
        var lagging = GitForgeState.empty
        lagging.branch = "feat/x"
        let kept = pin.resolve(lagging)
        XCTAssertTrue(kept.keep)
        XCTAssertEqual(kept.state.pr?.number, 5, "a poll that doesn't list the new PR yet does not remove it")

        var arrived = lagging
        arrived.pr = GitPullRequest(number: 5, title: "from the forge")
        let done = pin.resolve(arrived)
        XCTAssertFalse(done.keep)
        XCTAssertEqual(done.state.pr?.title, "from the forge")

        var moved = GitForgeState.empty
        moved.branch = "feat/other"
        let dropped = pin.resolve(moved)
        XCTAssertFalse(dropped.keep)
        XCTAssertNil(dropped.state.pr)
    }

    // MARK: rate-limited review read + lossy decode

    func testRateLimitedEmptyIsOnlyStaleNoFilesNoError() throws {
        XCTAssertTrue(try decode(GitDiffResult.self, #"{ "files": [], "stale": true, "error": null, "threads": [] }"#).isRateLimitedEmpty)
        XCTAssertFalse(try decode(GitDiffResult.self, #"{ "files": [], "stale": false, "error": null }"#).isRateLimitedEmpty, "a real empty diff")
        XCTAssertFalse(try decode(GitDiffResult.self, #"{ "files": [], "stale": true, "error": "no_pr" }"#).isRateLimitedEmpty)
        XCTAssertFalse(try decode(GitDiffResult.self, #"{ "files": [], "stale": true, "parseFailed": true }"#).isRateLimitedEmpty)
        XCTAssertFalse(try decode(GitDiffResult.self, #"{ "stale": true }"#).isRateLimitedEmpty, "no files key = an older box")
    }

    func testOneMalformedElementDoesNotDropTheList() throws {
        let r = try decode(GitDiffResult.self, #"""
        { "files": [ { "path": "a.ts", "rows": [ { "kind": "added", "text": "x" }, 7 ] }, { "nope": 1 } ],
          "threads": [ { "id": "t1" }, { "path": "no-id" }, { "id": "t2" } ],
          "draft": { "comments": [ { "id": "c1" }, { "body": "no id" } ] } }
        """#)
        XCTAssertEqual(r.files?.map(\.path), ["a.ts"])
        XCTAssertEqual(r.files?.first?.rows.count, 1)
        XCTAssertEqual(r.threads.map(\.id), ["t1", "t2"])
        XCTAssertEqual(r.draft?.comments.map(\.id), ["c1"])
        let pr = try decode(GitPullRequestResult.self, #"{ "checks": [ { "name": "ok" }, { "status": "x" } ] }"#)
        XCTAssertEqual(pr.checks.map(\.name), ["ok"])
    }
}
