import XCTest
@testable import MantaUI

// ===========================================================================
// WS05 Feature E — the work inbox store through its closure seam. Needs the app
// target (Combine, `NewSessionDraft`'s app file set), so this runs on the Mac with
// the rest of MantaUITests; the pure logic is in `InboxWorkTests` (verify.sh).
// ===========================================================================

private actor FakeInboxBox {
    var inboxCalls = 0
    var delegateCalls: [(prompt: String, sessionID: String, directory: String)] = []
    var result: WorkInboxResult
    var delegateResult = GitDelegateStartResult(ok: true)

    init(_ result: WorkInboxResult) { self.result = result }

    func nextInbox() -> WorkInboxResult {
        inboxCalls += 1
        return result
    }

    func recordDelegate(_ prompt: String, _ sessionID: String, _ directory: String) -> GitDelegateStartResult {
        delegateCalls.append((prompt, sessionID, directory))
        return delegateResult
    }

    func setDelegateResult(_ r: GitDelegateStartResult) { delegateResult = r }
}

@MainActor
final class InboxWorkStoreTests: XCTestCase {

    private func item(_ number: Int, kind: String = "pr", localPath: String? = "/home/dev/manta") -> WorkInboxItem {
        WorkInboxItem(
            kind: kind, repoKey: "github.com/acme/manta", number: number, title: "T\(number)", url: "https://gh/\(number)",
            state: "open", rollup: "red", updatedAt: 1, reason: "checks failing", seed: "Complete https://gh/\(number)",
            label: "checks red", identifier: "!\(number)", secondary: "checks red · manta", repoName: "manta",
            tone: .danger, branchName: "manta/pr-\(number)-t\(number)", localPath: localPath
        )
    }

    nonisolated private static func sampleProjects() -> [MantaProject] {
        [MantaProject(tmuxSession: "p", defaultCwd: "/home/dev/manta", windows: [
            MantaWindow(index: 0, name: "chat", active: true, paneCurrentPath: "/home/dev/manta/src", opencodeSessionId: "ses_1", worktreePath: nil)
        ], attached: false, mantaOwned: nil)]
    }

    private func store(_ box: FakeInboxBox) -> InboxWorkStore {
        InboxWorkStore(client: InboxWorkClient(
            inbox: { await box.nextInbox() },
            projects: { Self.sampleProjects() },
            delegateStart: { prompt, sessionID, directory in await box.recordDelegate(prompt, sessionID, directory) }
        ))
    }

    func testStartSessionCallsNavigatorAndCreatesNothing() async throws {
        let box = FakeInboxBox(WorkInboxResult(items: [item(412)]))
        let store = store(box)
        await store.load()
        let draft = try XCTUnwrap(store.startSessionDraft(for: store.items[0]))
        XCTAssertEqual(draft, NewSessionDraft(
            cwd: "/home/dev/manta", text: "Complete https://gh/412", attachments: [],
            worktreeBranch: "manta/pr-412-t412", linkedIssueURL: "https://gh/412"
        ))
        let delegates = await box.delegateCalls
        XCTAssertTrue(delegates.isEmpty, "the inbox itself creates nothing — the create sheet does, on Create")
        // The navigator holds it for the create sheet.
        let navigator = MantaNavigator()
        navigator.startNewSession(draft)
        XCTAssertEqual(navigator.pendingDraft, draft)
    }

    func testLoadCallsInboxOnlyNotProbe() async {
        let box = FakeInboxBox(WorkInboxResult(items: [item(1), item(2)]))
        let store = store(box)
        await store.load()
        let calls = await box.inboxCalls
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(store.phase, .loaded)
        XCTAssertEqual(store.items.count, 2)
        XCTAssertEqual(store.chatSessions.map(\.sessionID), ["ses_1"])
    }

    func testNotConnectedIsItsOwnPhase() async {
        let box = FakeInboxBox(WorkInboxResult(items: [], stale: false, error: "not_connected"))
        let store = store(box)
        await store.load()
        XCTAssertEqual(store.phase, .notConnected)
    }

    func testNoCheckoutSaysSo() async {
        let box = FakeInboxBox(WorkInboxResult(items: [item(9, localPath: nil)]))
        let store = store(box)
        await store.load()
        XCTAssertNil(store.startSessionDraft(for: store.items[0]))
        XCTAssertEqual(store.actionError, "No local checkout of manta on this server to start a session in.")
    }

    func testDelegateReportsBothOutcomes() async {
        let box = FakeInboxBox(WorkInboxResult(items: [item(5)]))
        let store = store(box)
        await store.load()
        let parent = store.parentCandidates(for: store.items[0]).first
        XCTAssertEqual(parent?.sessionID, "ses_1")
        guard let parent else { return }

        await store.delegate(store.items[0], under: parent)
        XCTAssertEqual(store.actionNotice, "Background job started under chat")
        XCTAssertNil(store.actionError)
        let calls = await box.delegateCalls
        XCTAssertEqual(calls.first?.sessionID, "ses_1")
        XCTAssertEqual(calls.first?.directory, "/home/dev/manta")
        XCTAssertEqual(calls.first?.prompt, "Complete https://gh/5")

        await box.setDelegateResult(GitDelegateStartResult(ok: false, error: "the box is full"))
        await store.delegate(store.items[0], under: parent)
        XCTAssertEqual(store.actionError, "the box is full")
        XCTAssertNil(store.actionNotice)

        await box.setDelegateResult(GitDelegateStartResult(ok: false, error: nil))
        await store.delegate(store.items[0], under: parent)
        XCTAssertEqual(store.actionError, "Couldn't start the background job.")
    }
}
