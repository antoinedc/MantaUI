import XCTest
@testable import MantaUI

/// WS05 Feature E — the work inbox: decoding the box's rows (label, identifier,
/// secondary, tone, branch name, local checkout) and the client-side bits (filter,
/// age, parent candidates, draft fields). Sorting, dedupe, labels and the checkout
/// join are the box's — `src/server/forge/view.test.mjs`. Pure — runs under
/// `verify.sh`.
final class InboxWorkTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let boxJSON = #"""
    { "items": [
        { "kind": "pr", "repoKey": "github.com/acme/manta", "number": 412, "title": "Fix the thing", "url": "https://gh/pr/412",
          "state": "open", "rollup": "red", "updatedAt": 1700000000000, "reason": "checks failing", "seed": "Complete https://gh/pr/412",
          "label": "checks red", "identifier": "!412", "secondary": "checks red · manta", "repoName": "manta",
          "tone": "danger", "branchName": "manta/pr-412-fix-the-thing", "localPath": "/home/dev/projects/manta" },
        { "kind": "issue", "repoKey": "github.com/acme/web", "number": 88, "title": "Broken nav", "url": "https://gh/issues/88",
          "state": "open", "rollup": "none", "updatedAt": 1699990000000, "reason": "assigned", "seed": "Complete https://gh/issues/88",
          "label": "issue · assigned to you", "identifier": "#88", "secondary": "issue · assigned to you", "repoName": "web",
          "tone": "muted", "branchName": "manta/issue-88-broken-nav", "localPath": null }
      ], "stale": false, "error": null }
    """#

    func testDecodeRowFieldsFromBox() throws {
        let r = try decode(WorkInboxResult.self, boxJSON)
        XCTAssertEqual(r.items.count, 2)
        let pr = r.items[0]
        XCTAssertTrue(pr.isPullRequest)
        XCTAssertEqual(pr.id, "github.com/acme/manta#412")
        XCTAssertEqual(pr.label, "checks red")
        XCTAssertEqual(pr.identifier, "!412")
        XCTAssertEqual(pr.secondary, "checks red · manta")
        XCTAssertEqual(pr.repoName, "manta")
        XCTAssertEqual(pr.tone, .danger)
        XCTAssertEqual(pr.branchName, "manta/pr-412-fix-the-thing")
        XCTAssertEqual(pr.localPath, "/home/dev/projects/manta")
        XCTAssertEqual(pr.seed, "Complete https://gh/pr/412")
        XCTAssertEqual(pr.updatedAt, 1700000000000)
        XCTAssertFalse(r.items[1].isPullRequest)
        XCTAssertNil(r.items[1].localPath)
        XCTAssertEqual(r.items[1].tone, .muted)
        XCTAssertTrue(r.items.allSatisfy(\.hasBoxRowFields))
    }

    func testDecodeOldBoxItemWithoutLabel() throws {
        let r = try decode(WorkInboxResult.self, #"{ "items": [ { "kind": "issue", "repoKey": "h/o/r", "number": 1, "title": "t", "url": "u", "state": "open", "rollup": "none", "updatedAt": 1, "reason": "assigned", "seed": "s" } ], "stale": false, "error": null }"#)
        XCTAssertNil(r.items[0].label)
        XCTAssertFalse(r.items[0].hasBoxRowFields, "an older box sends no row fields")
        XCTAssertEqual(r.items[0].tone, .muted)
    }

    func testDecodeNotConnected() throws {
        let r = try decode(WorkInboxResult.self, #"{ "items": [], "stale": false, "error": "not_connected" }"#)
        XCTAssertEqual(r.error, "not_connected")
        XCTAssertTrue(r.items.isEmpty)
        let stale = try decode(WorkInboxResult.self, #"{ "items": [], "stale": true, "error": null }"#)
        XCTAssertTrue(stale.stale)
    }

    func testFilterByTitleAndNumber() throws {
        let items = try decode(WorkInboxResult.self, boxJSON).items
        XCTAssertEqual(WorkInbox.filter(items, query: "").map(\.number), [412, 88])
        XCTAssertEqual(WorkInbox.filter(items, query: "  ").map(\.number), [412, 88])
        XCTAssertEqual(WorkInbox.filter(items, query: "THING").map(\.number), [412], "case-insensitive title match")
        XCTAssertEqual(WorkInbox.filter(items, query: "88").map(\.number), [88])
        XCTAssertEqual(WorkInbox.filter(items, query: "8").map(\.number), [88])
        XCTAssertEqual(WorkInbox.filter(items, query: "41").map(\.number), [412])
        XCTAssertTrue(WorkInbox.filter(items, query: "zzz").isEmpty)
        XCTAssertEqual(WorkInbox.noMatchMessage("zzz"), "No inbox matches “zzz”")
    }

    func testFormatAgeBuckets() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        func age(_ secondsAgo: Double) -> String {
            WorkInbox.formatAge(ms: (now.timeIntervalSince1970 - secondsAgo) * 1000, now: now)
        }
        XCTAssertEqual(age(0), "now")
        XCTAssertEqual(age(59), "now")
        XCTAssertEqual(age(60), "1m")
        XCTAssertEqual(age(59 * 60), "59m")
        XCTAssertEqual(age(60 * 60), "1h")
        XCTAssertEqual(age(23 * 3600), "23h")
        XCTAssertEqual(age(24 * 3600), "1d")
        XCTAssertEqual(age(9 * 86400), "9d")
        XCTAssertEqual(age(-30), "now", "a clock slightly ahead is still now")
    }

    func testDraftFieldsCarryPathBranchSeedAndURL() throws {
        let item = try decode(WorkInboxResult.self, boxJSON).items[0]
        XCTAssertEqual(
            WorkInbox.draftFields(for: item),
            WorkInboxDraftFields(
                cwd: "/home/dev/projects/manta",
                text: "Complete https://gh/pr/412",
                worktreeBranch: "manta/pr-412-fix-the-thing",
                linkedIssueURL: "https://gh/pr/412"
            )
        )
    }

    func testDraftFieldsNilWithoutCheckout() throws {
        let item = try decode(WorkInboxResult.self, boxJSON).items[1]
        XCTAssertNil(WorkInbox.draftFields(for: item))
        XCTAssertEqual(
            WorkInbox.noCheckoutMessage(repoName: "web"),
            "No local checkout of web on this server to start a session in."
        )
        var empty = item
        empty.localPath = ""
        XCTAssertNil(WorkInbox.draftFields(for: empty))
    }

    func testParentCandidatesRepoFirst() {
        let sessions = [
            WorkInboxSession(sessionID: "s1", name: "other", cwd: "/home/dev/projects/web"),
            WorkInboxSession(sessionID: "s2", name: "in repo", cwd: "/home/dev/projects/manta/src"),
            WorkInboxSession(sessionID: "s3", name: "at root", cwd: "/home/dev/projects/manta"),
            WorkInboxSession(sessionID: "s4", name: "sibling prefix", cwd: "/home/dev/projects/manta-ui"),
        ]
        let ordered = WorkInbox.parentCandidates(sessions: sessions, repoPath: "/home/dev/projects/manta")
        XCTAssertEqual(ordered.map(\.sessionID), ["s2", "s3", "s1", "s4"], "inside the repo first; a sibling dir with the same prefix is NOT inside")
        XCTAssertEqual(WorkInbox.parentCandidates(sessions: sessions, repoPath: "/home/dev/projects/manta/").map(\.sessionID), ["s2", "s3", "s1", "s4"])
        XCTAssertEqual(WorkInbox.parentCandidates(sessions: [], repoPath: "/x"), [])
    }

    func testSessionsFromProjectsSkipJobsAndTerminals() {
        let projects = [
            MantaProject(tmuxSession: "p", defaultCwd: "/root", windows: [
                MantaWindow(index: 0, name: "chat", active: true, paneCurrentPath: "/root/a", opencodeSessionId: "ses_1", worktreePath: nil),
                MantaWindow(index: 1, name: "term", active: false, paneCurrentPath: "/root", opencodeSessionId: nil, worktreePath: nil),
                MantaWindow(index: 2, name: "job", active: false, paneCurrentPath: "/root", opencodeSessionId: "ses_job", worktreePath: nil, owner: "job"),
                MantaWindow(index: 3, name: "bare", active: false, paneCurrentPath: "", opencodeSessionId: "ses_2", worktreePath: nil),
            ], attached: false, mantaOwned: nil)
        ]
        XCTAssertEqual(
            WorkInbox.sessions(from: projects),
            [
                WorkInboxSession(sessionID: "ses_1", name: "chat", cwd: "/root/a"),
                WorkInboxSession(sessionID: "ses_2", name: "bare", cwd: "/root"),
            ]
        )
    }
}
