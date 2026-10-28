import Foundation

// ===========================================================================
// WS05 Feature E — the WORK inbox (issues assigned to you, PRs awaiting your
// review, your PRs with red checks), pure half (Foundation only).
//
// NOT `InboxModels.swift`: that file is the pending-messages inbox (steer /
// queue) — unrelated. Types here are `WorkInbox*`.
//
// SERVER-FIRST (G13): the box dedupes, sorts, and returns every row's label,
// identifier, secondary line, repo name, tone, suggested branch name and the
// local checkout of its repo. What stays here: the filter box (G14), the age
// clock, which chats a background job can run under (G15) and the mapping to a
// new-session draft (G16).
// ===========================================================================

struct WorkInboxItem: Decodable, Equatable, Sendable, Identifiable {
    /// "issue" | "pr".
    var kind: String
    var repoKey: String
    var number: Int
    var title: String
    var url: String
    var state: String
    var rollup: String
    /// Epoch milliseconds.
    var updatedAt: Double
    var reason: String
    /// The box's seeded first prompt ("Complete <url>").
    var seed: String
    // The box's row fields. nil on a box without `forge-inbox-view-1`.
    var label: String?
    var identifier: String?
    var secondary: String?
    var repoName: String?
    var tone: GitTone
    var branchName: String?
    /// The checkout of this repo on the box, or nil when it has none.
    var localPath: String?

    var id: String { "\(repoKey)#\(number)" }
    var isPullRequest: Bool { kind == "pr" }
    /// The box answered with the row fields (an older box does not).
    var hasBoxRowFields: Bool { label != nil }

    private enum CodingKeys: String, CodingKey {
        case kind, repoKey, number, title, url, state, rollup, updatedAt, reason, seed
        case label, identifier, secondary, repoName, tone, branchName, localPath
    }

    init(kind: String, repoKey: String, number: Int, title: String = "", url: String = "", state: String = "",
         rollup: String = "none", updatedAt: Double = 0, reason: String = "", seed: String = "",
         label: String? = nil, identifier: String? = nil, secondary: String? = nil, repoName: String? = nil,
         tone: GitTone = .muted, branchName: String? = nil, localPath: String? = nil) {
        self.kind = kind
        self.repoKey = repoKey
        self.number = number
        self.title = title
        self.url = url
        self.state = state
        self.rollup = rollup
        self.updatedAt = updatedAt
        self.reason = reason
        self.seed = seed
        self.label = label
        self.identifier = identifier
        self.secondary = secondary
        self.repoName = repoName
        self.tone = tone
        self.branchName = branchName
        self.localPath = localPath
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "issue"
        repoKey = try c.decode(String.self, forKey: .repoKey)
        if let n = (try? c.decodeIfPresent(Int.self, forKey: .number)) ?? nil {
            number = n
        } else {
            number = Int(try c.decode(Double.self, forKey: .number))
        }
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? ""
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? ""
        rollup = (try? c.decodeIfPresent(String.self, forKey: .rollup)) ?? "none"
        updatedAt = (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
        seed = (try? c.decodeIfPresent(String.self, forKey: .seed)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil
        identifier = (try? c.decodeIfPresent(String.self, forKey: .identifier)) ?? nil
        secondary = (try? c.decodeIfPresent(String.self, forKey: .secondary)) ?? nil
        repoName = (try? c.decodeIfPresent(String.self, forKey: .repoName)) ?? nil
        tone = GitTone(wire: (try? c.decodeIfPresent(String.self, forKey: .tone)) ?? nil)
        branchName = (try? c.decodeIfPresent(String.self, forKey: .branchName)) ?? nil
        localPath = (try? c.decodeIfPresent(String.self, forKey: .localPath)) ?? nil
    }
}

/// `forge:inbox`.
struct WorkInboxResult: Decodable, Equatable, Sendable {
    var items: [WorkInboxItem]
    var stale: Bool
    /// "not_connected" | nil.
    var error: String?

    private enum CodingKeys: String, CodingKey { case items, stale, error }

    init(items: [WorkInboxItem] = [], stale: Bool = false, error: String? = nil) {
        self.items = items
        self.stale = stale
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = ((try? c.decodeIfPresent([WorkInboxItem].self, forKey: .items)) ?? nil) ?? []
        stale = (try? c.decodeIfPresent(Bool.self, forKey: .stale)) ?? false
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
    }
}

/// A chat session a background job could run under.
struct WorkInboxSession: Equatable, Sendable {
    var sessionID: String
    var name: String
    var cwd: String
}

/// The fields of a new-session draft an inbox row maps to (the store hands them
/// 1:1 to `NewSessionDraft`, which lives in the app-only navigation file).
struct WorkInboxDraftFields: Equatable, Sendable {
    var cwd: String
    var text: String
    var worktreeBranch: String?
    var linkedIssueURL: String?
}

enum WorkInbox {
    static let notConnectedMessage = "GitHub isn't connected on this server."
    static let loadFailedMessage = "Couldn't load the inbox."
    static let emptyMessage = "Nothing needs you right now."
    static let updateBoxMessage = "Update your box to use the inbox here."

    static func noMatchMessage(_ query: String) -> String { "No inbox matches “\(query)”" }

    static func noCheckoutMessage(repoName: String) -> String {
        "No local checkout of \(repoName) on this server to start a session in."
    }

    /// G14: title contains the query (case-insensitive), or the number does.
    static func filter(_ items: [WorkInboxItem], query: String) -> [WorkInboxItem] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return items }
        return items.filter { $0.title.lowercased().contains(q) || String($0.number).contains(q) }
    }

    /// "now" / "Nm" / "Nh" / "Nd" — the desktop's ladder, from epoch ms.
    static func formatAge(ms: Double, now: Date) -> String {
        let elapsed = now.timeIntervalSince1970 * 1000 - ms
        if !elapsed.isFinite || elapsed < 60_000 { return "now" }
        let minutes = Int(elapsed / 60_000)
        if minutes < 60 { return "\(minutes)m" }
        let hours = Int(elapsed / 3_600_000)
        if hours < 24 { return "\(hours)h" }
        return "\(Int(elapsed / 86_400_000))d"
    }

    /// G15: the chats a background job can nest under — chat windows that are
    /// not background jobs themselves.
    static func sessions(from projects: [MantaProject]) -> [WorkInboxSession] {
        var out: [WorkInboxSession] = []
        for project in projects {
            for window in project.windows {
                guard let sid = window.opencodeSessionId, !sid.isEmpty, !window.isJobWindow else { continue }
                let cwd = window.paneCurrentPath.isEmpty ? project.defaultCwd : window.paneCurrentPath
                out.append(WorkInboxSession(sessionID: sid, name: window.name, cwd: cwd))
            }
        }
        return out
    }

    /// Sessions whose directory is inside the repo come first (order kept inside
    /// each group); the rest follow.
    static func parentCandidates(sessions: [WorkInboxSession], repoPath: String) -> [WorkInboxSession] {
        let root = repoPath.hasSuffix("/") ? String(repoPath.dropLast()) : repoPath
        func inside(_ s: WorkInboxSession) -> Bool {
            !root.isEmpty && (s.cwd == root || s.cwd.hasPrefix(root + "/"))
        }
        return sessions.filter(inside) + sessions.filter { !inside($0) }
    }

    /// G16: nil when the repo has no checkout on the box (nothing to start in).
    static func draftFields(for item: WorkInboxItem) -> WorkInboxDraftFields? {
        guard let path = item.localPath, !path.isEmpty else { return nil }
        return WorkInboxDraftFields(
            cwd: path,
            text: item.seed,
            worktreeBranch: item.branchName,
            linkedIssueURL: item.url.isEmpty ? nil : item.url
        )
    }
}
