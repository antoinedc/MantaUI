import Foundation

// ===========================================================================
// WS04 §7/§8 + WS11 D6 — closing sessions and whole projects. The confirm
// copy, the worktree orchestration, the notices and the warnings are the BOX's
// (`sessions:close-preview` / `sessions:close`); this file holds the wire
// shapes and the UI queue value types. Foundation-only (D19).
// ===========================================================================

// MARK: - Wire (sessions:close-preview / sessions:close)

/// A confirm sheet's wording — the box's preview, ready to show.
struct SessionCloseConfirm: Equatable, Sendable {
    var title: String
    var body: String
    var destructiveTitle: String
}

/// `sessions:close-preview` → the confirm dialog's words and facts.
struct SessionClosePreview: Decodable, Equatable, Sendable {
    struct Worktree: Decodable, Equatable, Sendable {
        var path: String
        var willRemove: Bool
    }

    var title: String
    var body: String
    var confirmLabel: String
    var runningCount: Int = 0
    var worktrees: [Worktree] = []

    private enum CodingKeys: String, CodingKey { case title, body, confirmLabel, runningCount, worktrees }

    init(title: String, body: String, confirmLabel: String, runningCount: Int = 0, worktrees: [Worktree] = []) {
        self.title = title
        self.body = body
        self.confirmLabel = confirmLabel
        self.runningCount = runningCount
        self.worktrees = worktrees
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        body = try c.decode(String.self, forKey: .body)
        confirmLabel = try c.decode(String.self, forKey: .confirmLabel)
        runningCount = ((try? c.decodeIfPresent(Int.self, forKey: .runningCount)) ?? nil) ?? 0
        worktrees = ((try? c.decodeIfPresent([Worktree].self, forKey: .worktrees)) ?? nil) ?? []
    }

    var confirm: SessionCloseConfirm {
        SessionCloseConfirm(title: title, body: body, destructiveTitle: confirmLabel)
    }
}

/// The box asking about a dirty worktree before a single-window close (nothing was killed).
struct SessionCloseAsk: Decodable, Equatable, Sendable {
    var path: String
    var title: String
    var body: String
    var removeLabel: String
    var keepLabel: String
}

/// `sessions:close` → what the close did (as data), or the question, or a sentence.
struct SessionCloseResult: Decodable, Equatable, Sendable {
    struct Failure: Decodable, Equatable, Sendable {
        var path: String
        var message: String
    }

    var ok: Bool
    var removed: [String] = []
    var kept: [String] = []
    var failed: [Failure] = []
    var warnings: [String] = []
    var notice: String?
    var needsConfirm: SessionCloseAsk?
    var error: String?

    private enum CodingKeys: String, CodingKey { case ok, removed, kept, failed, warnings, notice, needsConfirm, error }

    init(ok: Bool, removed: [String] = [], kept: [String] = [], failed: [Failure] = [], warnings: [String] = [],
         notice: String? = nil, needsConfirm: SessionCloseAsk? = nil, error: String? = nil) {
        self.ok = ok
        self.removed = removed
        self.kept = kept
        self.failed = failed
        self.warnings = warnings
        self.notice = notice
        self.needsConfirm = needsConfirm
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = ((try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil) ?? false
        removed = ((try? c.decodeIfPresent([String].self, forKey: .removed)) ?? nil) ?? []
        kept = ((try? c.decodeIfPresent([String].self, forKey: .kept)) ?? nil) ?? []
        failed = ((try? c.decodeIfPresent([Failure].self, forKey: .failed)) ?? nil) ?? []
        warnings = ((try? c.decodeIfPresent([String].self, forKey: .warnings)) ?? nil) ?? []
        notice = (try? c.decodeIfPresent(String.self, forKey: .notice)) ?? nil
        needsConfirm = (try? c.decodeIfPresent(SessionCloseAsk.self, forKey: .needsConfirm)) ?? nil
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
    }
}

// MARK: - The user's choice for a dirty worktree

/// What the user chose for a dirty worktree.
enum SessionCloseChoice: Equatable, Sendable {
    case none, keep, remove

    /// The `dirtyWorktree` the box takes (absent = ask).
    var wire: String? {
        switch self {
        case .none: return nil
        case .keep: return "keep"
        case .remove: return "remove"
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
    /// The box's question (title, body, button labels).
    var ask: SessionCloseAsk

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
    /// Closed, but a non-fatal step failed (a worktree left in place, project settings not cleared).
    case closedWithWarnings([String])
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

/// The result of closing a whole project, as the list shows it.
struct SessionCloseReport: Equatable, Sendable {
    /// The project's tmux session was actually killed.
    var killed = false
    /// The box's notice and warnings, in order — shown after the close.
    var lines: [String] = []
}
