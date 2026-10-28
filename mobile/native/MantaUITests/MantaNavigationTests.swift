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

    func testResetForgetsEverythingAddressedToTheOldBox() {
        let nav = MantaNavigator()
        nav.open(.review(sessionID: "s"))
        nav.startNewSession(NewSessionDraft(text: "x"))
        nav.presentSwitcher()

        nav.reset()

        XCTAssertNil(nav.pending)
        XCTAssertNil(nav.pendingDraft)
        XCTAssertFalse(nav.switcherPresented)
    }

    func testModeSwitchProducesADifferentNavigationValue() throws {
        let suite = "MantaNavigationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let asChat = SessionOpenTarget.opened(project: "p", windowIndex: 1, name: "n", sessionId: "ses_1", defaults: defaults)
        SessionModeStore.write(.terminal, sessionID: "ses_1", defaults: defaults)
        let asTerminal = SessionOpenTarget.opened(project: "p", windowIndex: 1, name: "n", sessionId: "ses_1", defaults: defaults)
        let again = SessionOpenTarget.opened(project: "p", windowIndex: 1, name: "n", sessionId: "ses_1", defaults: defaults)

        // A switch is a real replace (the values differ)…
        XCTAssertNotEqual(asChat, asTerminal)
        XCTAssertEqual(asChat.mode, .chat)
        XCTAssertEqual(asTerminal.mode, .terminal)
        // …and re-opening in the mode it is already in is the same value.
        XCTAssertEqual(asTerminal, again)
        // A window with no chat session has no mode.
        XCTAssertNil(SessionOpenTarget.opened(project: "p", windowIndex: 2, name: "t", sessionId: nil, defaults: defaults).mode)
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
