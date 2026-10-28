import Foundation

/// App-wide destinations (master spec C2). Foundation-only so the pure
/// route/draft logic builds under `verify.sh`; the observable navigator that
/// carries these values lives in `MantaNavigation.swift`.
enum MantaRoute: Hashable, Sendable {
    /// windowKey = "<project>#<windowIndex>"
    case session(windowKey: String)
    case message(sessionID: String, messageID: String)
    case review(sessionID: String)
    case settings(section: String?)
}

struct NewSessionDraftAttachment: Hashable, Sendable {
    var remotePath: String
    var displayName: String
    var mime: String?
}

/// The single hand-off value for "start a new session with this" (master D2/D11).
struct NewSessionDraft: Hashable, Sendable {
    /// Absolute box path; nil = the user picks.
    var cwd: String?
    /// Placed in the new chat's composer — never auto-sent.
    var text: String
    var attachments: [NewSessionDraftAttachment]
    /// Non-nil pre-ticks "new worktree" with this branch name.
    var worktreeBranch: String?
    /// Informational; shown in the create sheet header.
    var linkedIssueURL: String?

    init(
        cwd: String? = nil,
        text: String = "",
        attachments: [NewSessionDraftAttachment] = [],
        worktreeBranch: String? = nil,
        linkedIssueURL: String? = nil
    ) {
        self.cwd = cwd
        self.text = text
        self.attachments = attachments
        self.worktreeBranch = worktreeBranch
        self.linkedIssueURL = linkedIssueURL
    }
}
