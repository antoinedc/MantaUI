import Foundation

// ===========================================================================
// WS04 §7/§8 — closing sessions and whole projects, as PURE logic.
// Foundation-only (D19); uses `MantaProject` from `SessionModels.swift`.
//
// Ports of `describeSessionClose` / `describeProjectClose`
// (`chatUtils.ts:5131-5175`) and the notice wording of `Sidebar.tsx:337-342`,
// plus the decision the worktree-on-close flow takes (`Sidebar.tsx:240-294`).
// ===========================================================================

// MARK: - Copy

/// A confirm sheet's wording.
struct SessionCloseConfirm: Equatable, Sendable {
    var title: String
    var body: String
    var destructiveTitle: String
}

enum SessionCloseCopy {
    /// "Its worktree at <path> will be removed." — shared by the one-session
    /// and running-turn confirms.
    static func worktreeRemovalSentence(path: String) -> String {
        "Its worktree at \(path) will be removed."
    }

    /// Confirm for closing ONE session.
    static func session(name: String, running: Bool, worktreePath: String?) -> SessionCloseConfirm {
        var parts = ["Its tmux window will be killed on the server."]
        if running { parts.append("A turn is currently running and will be stopped.") }
        if let worktreePath, !worktreePath.isEmpty { parts.append(worktreeRemovalSentence(path: worktreePath)) }
        return SessionCloseConfirm(title: "Close “\(name)”?", body: parts.joined(separator: " "), destructiveTitle: "Close session")
    }

    /// Confirm for closing a WHOLE project.
    static func project(name: String, sessionCount: Int, runningCount: Int, worktreeCount: Int) -> SessionCloseConfirm {
        let title = sessionCount == 0
            ? "Close “\(name)”?"
            : "Close “\(name)” and its \(sessionCount) session\(sessionCount == 1 ? "" : "s")?"
        var parts = [
            sessionCount == 0
                ? "Its tmux session will be killed on the server."
                : "All \(sessionCount) tmux window\(sessionCount == 1 ? "" : "s") will be killed on the server."
        ]
        if runningCount > 0 {
            parts.append("\(runningCount) session\(runningCount == 1 ? " is" : "s are") mid-turn and will be stopped.")
        }
        if worktreeCount > 0 {
            parts.append("\(worktreeCount) worktree\(worktreeCount == 1 ? "" : "s") will be removed.")
        }
        return SessionCloseConfirm(title: title, body: parts.joined(separator: " "), destructiveTitle: "Close project")
    }

    /// The notice after dirty worktrees were kept; nil when nothing was kept.
    static func kept(_ paths: [String]) -> String? {
        switch paths.count {
        case 0: return nil
        case 1: return "Kept worktree at \(paths[0]) — it has uncommitted changes."
        default: return "Kept \(paths.count) worktrees with uncommitted changes."
        }
    }

    /// The prompt for ONE session whose worktree has uncommitted work.
    static func dirtyWorktree(path: String) -> (title: String, body: String) {
        ("Uncommitted changes in this worktree",
         "\(path) has uncommitted changes. Removing the worktree will permanently delete that work.")
    }
}

// MARK: - Counts

/// What a project close will touch. Counted over the COMPLETE project, not the
/// visible windows: hidden background-job windows are killed and their
/// worktrees removed too (desktop counts `proj.windows`).
enum SessionCloseCounts {
    struct Counts: Equatable, Sendable {
        var sessionCount: Int
        var runningCount: Int
        var worktreeCount: Int
    }

    static func project(_ project: MantaProject, isRunning: (MantaWindow) -> Bool, cleanOnClose: Bool) -> Counts {
        let windows = project.windows
        return Counts(
            sessionCount: windows.count,
            runningCount: windows.filter(isRunning).count,
            worktreeCount: cleanOnClose ? windows.filter { !($0.worktreePath ?? "").isEmpty }.count : 0
        )
    }
}

// MARK: - The decision the close flow takes for ONE window

/// What the user chose for a dirty worktree.
enum SessionCloseChoice: Equatable, Sendable {
    case none, keep, remove
}

/// How a window was finally closed.
enum SessionCloseOutcome: Equatable, Sendable {
    case plain
    /// The window was killed but its worktree was deliberately left in place.
    case keptWorktree(path: String)
    /// The window was killed but removing its worktree failed for another reason.
    case removalFailed(path: String)
}

enum SessionCloseStep: Equatable, Sendable {
    /// Run `git:remove-worktree` and call `next` again with the result.
    case removeWorktree(force: Bool)
    /// A dirty worktree and no decision yet: ask the user.
    case ask
    case kill(SessionCloseOutcome)
}

enum SessionCloseDecision {
    /// `removal` is nil until a removal has been attempted. A removal that threw
    /// something other than "dirty" is `SessionWorktreeRemoval.otherFailure`.
    static func next(cleanOnClose: Bool, worktreePath: String?, removal: SessionWorktreeRemoval?,
                     decision: SessionCloseChoice) -> SessionCloseStep {
        guard cleanOnClose, let path = worktreePath, !path.isEmpty else { return .kill(.plain) }
        switch decision {
        case .keep:
            return .kill(.keptWorktree(path: path))
        case .remove:
            guard let removal else { return .removeWorktree(force: true) }
            return removal.removed ? .kill(.plain) : .kill(.removalFailed(path: path))
        case .none:
            guard let removal else { return .removeWorktree(force: false) }
            if removal.removed { return .kill(.plain) }
            if removal.isDirty { return .ask }
            return .kill(.removalFailed(path: path))
        }
    }
}

// MARK: - Queue + prompts + feedback value types

/// The user's answer to a worktree prompt. `cancel` does nothing at all: no RPC,
/// the row stays.
enum SessionWorktreeAnswer: Equatable, Sendable {
    case keep, remove, cancel
}

/// One session close waiting in (or running through) the store's FIFO queue.
struct SessionCloseRequest: Equatable, Sendable {
    var project: String
    var index: Int
    var decision: SessionCloseChoice = .none

    var key: String { "\(project)#\(index)" }
}

/// A dirty worktree waiting for the user's decision. Keyed by the request key,
/// so two prompts never overwrite each other and a duplicate is not added.
struct SessionWorktreePrompt: Equatable, Sendable, Identifiable {
    var key: String
    var project: String
    var index: Int
    var windowName: String
    var worktreePath: String

    var id: String { key }
}

enum SessionWorktreePromptQueue {
    /// Appends unless a prompt with the same key is already queued.
    static func append(_ prompt: SessionWorktreePrompt, to queue: [SessionWorktreePrompt]) -> [SessionWorktreePrompt] {
        guard !queue.contains(where: { $0.key == prompt.key }) else { return queue }
        return queue + [prompt]
    }

    /// Removes exactly the prompt with `key`.
    static func resolve(key: String, in queue: [SessionWorktreePrompt]) -> [SessionWorktreePrompt] {
        queue.filter { $0.key != key }
    }
}

enum SessionCloseFeedbackKind: Equatable, Sendable {
    case closed
    case closedWithNotice(String)
    case failed(String)
}

/// A real outcome of a close. The view fires the haptic and the toast from
/// these — never from "an RPC was sent".
struct SessionCloseFeedback: Equatable, Sendable, Identifiable {
    var id: UUID
    var kind: SessionCloseFeedbackKind

    init(id: UUID = UUID(), kind: SessionCloseFeedbackKind) {
        self.id = id
        self.kind = kind
    }
}

/// The result of closing a whole project.
struct SessionCloseReport: Equatable, Sendable {
    /// Worktrees left in place because they had uncommitted changes.
    var keptWorktrees: [String] = []
    /// Failures, in order. Worktree and meta failures never stop the close.
    var errors: [String] = []
    /// The project's tmux session was actually killed.
    var killed = false
}
