import XCTest
@testable import MantaUI

// ===========================================================================
// WS04 §12 — the new-session draft's hand-off from the create sheet to the new
// chat (Mac-only: `SessionOpenTarget` and `ComposerTextController` are app
// types). The pure plan side is in `SessionsTests`.
// ===========================================================================

@MainActor
final class SessionDraftHandoffTests: XCTestCase {
    private let draft = NewSessionDraft(
        cwd: "/work/api",
        text: "Fix the login bug, see the screenshot",
        attachments: [
            NewSessionDraftAttachment(remotePath: "/u/shot.png", displayName: "shot.png", mime: "image/png"),
            NewSessionDraftAttachment(remotePath: "/u/log.txt", displayName: "log.txt", mime: "text/plain"),
        ],
        worktreeBranch: "fix/login",
        linkedIssueURL: "https://github.com/o/r/issues/7"
    )

    func testCreatedTargetCarriesDraftAndNoSeed() {
        let created = SessionCreated(
            project: "api", windowIndex: 2, sessionId: "ses_new", projects: [],
            mode: .chat, draft: draft
        )

        let target = created.openTarget(windowName: "session")

        XCTAssertNil(target.seed, "the draft is the ONLY text carrier")
        XCTAssertEqual(target.draft, draft)
        XCTAssertEqual(target.sessionId, "ses_new")
        XCTAssertEqual(target.windowIndex, 2)
        XCTAssertEqual(target.mode, .chat)
        XCTAssertEqual(target.name, "session")
    }

    func testTerminalCreateCarriesItsModeAndNoDraftText() {
        var plan = SessionCreateForm()
        plan.target = .existing
        plan.draft = draft
        plan.openAs = .terminal
        let made = SessionCreatePlan.make(plan)
        let created = SessionCreated(project: "api", windowIndex: 0, sessionId: "ses_new", projects: [],
                                     mode: made.mode, draft: made.draft)

        let target = created.openTarget(windowName: "session")

        XCTAssertEqual(target.mode, .terminal)
        XCTAssertEqual(target.draft?.text, "")
        XCTAssertEqual(target.draft?.attachments, [])
    }

    func testNewChatComposerHasDraftTextExactlyOnce() {
        // Built exactly as `ChatScreenContent.init` does for `seed: ""`, no
        // carry-over, and the target's draft.
        let composer = ComposerTextController(
            text: HandoffComposerCarry.appendBelow("", ""),
            attachments: [],
            draft: draft
        )

        XCTAssertEqual(composer.text, draft.text)
        XCTAssertEqual(composer.attachments.count, draft.attachments.count)
        XCTAssertEqual(composer.attachments.compactMap(\.remotePath), ["/u/shot.png", "/u/log.txt"])
        XCTAssertNil(composer.consumeSeedNotice())
    }

    func testDuplicateAttachmentInDraftRejectedOnce() {
        let dup = NewSessionDraft(text: "x", attachments: [
            NewSessionDraftAttachment(remotePath: "/u/a.png", displayName: "a.png", mime: "image/png"),
            NewSessionDraftAttachment(remotePath: "/u/a.png", displayName: "a.png", mime: "image/png"),
        ])
        let composer = ComposerTextController()

        let rejected = composer.apply(dup)

        XCTAssertEqual(rejected, 1)
        XCTAssertEqual(composer.attachments.count, 1)
    }

    func testDontCarryOverLeavesTheComposerEmpty() {
        var form = SessionCreateForm()
        form.target = .existing
        form.draft = draft
        form.dropCarryOver = true
        let made = SessionCreatePlan.make(form)

        let composer = ComposerTextController(text: "", attachments: [], draft: made.draft)

        XCTAssertEqual(composer.text, "")
        XCTAssertTrue(composer.attachments.isEmpty)
    }
}
