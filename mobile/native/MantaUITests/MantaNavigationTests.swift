import XCTest
@testable import MantaUI

// ===========================================================================
// WS04 §11 — the observable navigator (Mac-only: it is an `ObservableObject`).
// The pure route resolution is covered in `SessionsTests`.
// ===========================================================================

@MainActor
final class MantaNavigationTests: XCTestCase {
    func testOpenSetsPending() {
        let nav = MantaNavigator()
        XCTAssertNil(nav.pending)
        nav.open(.settings(section: "box"))
        XCTAssertEqual(nav.pending, .settings(section: "box"))
        nav.open(.session(windowKey: "p#1"))
        XCTAssertEqual(nav.pending, .session(windowKey: "p#1"))
    }

    func testStartNewSessionSetsDraft() {
        let nav = MantaNavigator()
        let draft = NewSessionDraft(cwd: "/r", text: "hello", worktreeBranch: "issue-1")
        nav.startNewSession(draft)
        XCTAssertEqual(nav.pendingDraft, draft)
        // A draft opens the create sheet; it never opens a route by itself.
        XCTAssertNil(nav.pending)
    }

    func testSwitchModeWritesModeThenOpensSession() throws {
        let sid = "ses_nav_\(UUID().uuidString)"
        let key = SessionModeStore.key(sessionID: sid)
        defer { UserDefaults.standard.removeObject(forKey: key) }
        let nav = MantaNavigator()

        nav.switchMode(windowKey: "p#2", sessionID: sid, to: .cli(launcherID: "claude"))

        XCTAssertEqual(SessionModeStore.read(sessionID: sid), .cli(launcherID: "claude"))
        XCTAssertEqual(nav.pending, .session(windowKey: "p#2"))
    }

    func testPresentSwitcher() {
        let nav = MantaNavigator()
        XCTAssertFalse(nav.switcherPresented)
        nav.presentSwitcher()
        XCTAssertTrue(nav.switcherPresented)
    }

    func testWindowKeyBuilder() {
        XCTAssertEqual(MantaNavigator.windowKey(project: "a#b", windowIndex: 3), "a#b#3")
    }

    func testTargetsWithDifferentModesAreDifferent() {
        let chat = SessionOpenTarget(project: "p", windowIndex: 0, name: "n", sessionId: "s", mode: .chat)
        let terminal = SessionOpenTarget(project: "p", windowIndex: 0, name: "n", sessionId: "s", mode: .terminal)
        XCTAssertNotEqual(chat, terminal)
        XCTAssertNotEqual(chat.hashValue, terminal.hashValue)
        XCTAssertEqual(chat, SessionOpenTarget(project: "p", windowIndex: 0, name: "renamed", sessionId: "s", mode: .chat))
    }

    func testSeedAndDraftAreNotIdentity() {
        let a = SessionOpenTarget(project: "p", windowIndex: 0, name: "n", sessionId: "s")
        let b = SessionOpenTarget(project: "p", windowIndex: 0, name: "n", sessionId: "s", seed: "quote", draft: NewSessionDraft(text: "x"))
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.hashValue, b.hashValue)
    }
}
