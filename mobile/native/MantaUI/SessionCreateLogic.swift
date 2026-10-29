import Foundation

// ===========================================================================
// WS04 §1/§3/§4/§5/§12 — the create-session flow's pure logic.
// Foundation-only (D19): everything the sheet DECIDES lives here so it can be
// tested without a simulator; `SessionCreateSheet` / `SessionSetupStore` are the
// I/O and views around it.
//
// The naming functions are ports of `src/shared/projectName.mjs`, which both
// desktop and box use — the same input must produce the same folder and
// session name on every client.
// ===========================================================================

// MARK: - Failure wording

enum SessionActionError {
    /// "Couldn't <verb> — <the box's reason>". Anything that is not the box's own
    /// words (a transport string, a decode failure, a URLError) reads "check the
    /// connection".
    static func message(_ verb: String, error: Error) -> String {
        // Only text the box wrote for a person is passed through; a transport
        // string ("tmux:new-session returned no result") means nothing to them.
        var reason = ""
        switch error {
        case MantaError.server(let text): reason = text
        case MantaError.authRequired: reason = "this device isn't signed in to the box"
        default: reason = ""
        }
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return "Couldn't \(verb) — \(trimmed.isEmpty ? "check the connection" : trimmed)"
    }
}

// MARK: - Rename

enum SessionRenameLogic {
    /// The trimmed name to send, or nil when it is unchanged (nothing to send — the desktop cancels with no
    /// RPC). Whether a name is VALID (empty, too long, a `:`) is the box's call: it refuses with a sentence
    /// (WS11 D5 / S2).
    static func changed(_ input: String, current: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == current ? nil : trimmed
    }
}

// MARK: - Naming

/// Naming is the box's (WS11 D5 / S1): it makes a name tmux-safe, unique and allocates it under a lock, and
/// previews it with `sessions:propose-name`. Only the display basename of a folder is derived here.
enum SessionNaming {
    /// The basename of a folder path; `"~"`, empty and `"/"` are `"project"`. A display label (the batch rows),
    /// never the name a session is created under.
    static func deriveProjectName(_ cwd: String) -> String {
        var clean = cwd
        while clean.hasSuffix("/") { clean.removeLast() }
        if clean.isEmpty || clean == "~" { return "project" }
        let last = clean.split(separator: "/", omittingEmptySubsequences: true).last
        return last.map(String.init) ?? "project"
    }
}

// MARK: - The create form → what the confirm button does

enum SessionWorktreeDefaults {
    /// The branch field's default (`store.ts:979-1006`).
    static let branch = "worktree"
}

struct SessionCreateForm: Equatable, Sendable {
    enum Target: Equatable, Sendable { case existing, newProject }
    /// For a new project: what the user chose to start from. `.none` = the scan
    /// list is showing and nothing has been picked yet.
    enum Source: Equatable, Sendable { case none, folder, scratch }

    var target: Target = .existing
    var source: Source = .none
    var newProjectName = ""
    var folder = ""
    var scratchName = ""
    var scratchRoot = ""
    /// The box's preview said the scratch name makes a usable folder (or no preview has arrived and the
    /// field is not blank — the create re-checks).
    var scratchUsable = false
    /// The name field was typed in: it is sent as the explicit name; otherwise the box names the session.
    var nameEdited = false
    /// The git probe said the folder is a repository.
    var worktreeAvailable = false
    var worktreeOn = false
    var worktreeBranch = SessionWorktreeDefaults.branch
    var checkedRepoCount = 0
    /// Worktrees the folder picker found (>1 = the fan-out choice was taken).
    var fanOutCount = 0
    var openAs: SessionMode = .chat
    var draft: NewSessionDraft? = nil
    /// "Don't carry over" was tapped.
    var dropCarryOver = false

    init() {}
}

extension NewSessionDraft {
    /// Text or attachments that would land in the new chat's composer.
    var hasCarryOver: Bool { !text.isEmpty || !attachments.isEmpty }
}

struct SessionCreatePlan: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case existingWindow
        case newProjectFolder
        case fanOut
        case scratch
        case repoBatch
    }

    struct Worktree: Equatable, Sendable {
        /// The folder the worktree is cut from.
        var cwd: String
        /// The branch name asked for (the box slugifies and de-duplicates it).
        var branch: String
    }

    var kind: Kind
    var label: String
    var enabled: Bool
    var worktree: Worktree?
    /// The mode the new session opens in (chat for the many-sessions kinds).
    var mode: SessionMode
    /// The draft the chat composer is seeded from — "Don't carry over" already
    /// applied. The ONLY carrier of the draft's text.
    var draft: NewSessionDraft?
    /// Always nil: the draft is the only text carrier, so text can't appear twice.
    let seed: String? = nil

    static func make(_ form: SessionCreateForm) -> SessionCreatePlan {
        let branch = form.worktreeBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let single: Bool
        let kind: Kind
        let label: String
        var enabled: Bool
        var wantsWorktree = form.worktreeAvailable && form.worktreeOn

        switch form.target {
        case .existing:
            kind = .existingWindow
            label = "Create"
            enabled = true
            single = true
        case .newProject:
            switch form.source {
            case .none:
                kind = .repoBatch
                label = form.checkedRepoCount > 0
                    ? "Set up \(form.checkedRepoCount) workspace\(form.checkedRepoCount == 1 ? "" : "s")"
                    : "Set up workspaces"
                enabled = form.checkedRepoCount > 0
                single = false
                wantsWorktree = false
            case .scratch:
                kind = .scratch
                label = "Create workspace"
                enabled = form.scratchUsable
                    && !form.scratchRoot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                single = true
                wantsWorktree = false
            case .folder:
                kind = form.fanOutCount > 1 ? .fanOut : .newProjectFolder
                label = "Create"
                enabled = (!form.nameEdited || !form.newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    && !form.folder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                single = kind == .newProjectFolder
                if kind == .fanOut { wantsWorktree = false }
            }
        }

        if wantsWorktree && branch.isEmpty { enabled = false }
        let mode: SessionMode = single ? form.openAs : .chat
        let worktree = wantsWorktree
            ? Worktree(cwd: form.folder.trimmingCharacters(in: .whitespacesAndNewlines), branch: branch)
            : nil

        var draft = form.draft
        if draft != nil, form.dropCarryOver || mode != .chat || !single {
            draft?.text = ""
            draft?.attachments = []
        }
        return SessionCreatePlan(kind: kind, label: label, enabled: enabled, worktree: worktree, mode: mode, draft: draft)
    }
}

/// Where a just-created session lands.
struct SessionCreateLanding: Equatable, Sendable {
    var mode: SessionMode
    /// The session id the pushed target carries. Nil = the plain terminal.
    var sessionId: String?
    /// The chosen mode must be saved for the session.
    var writesMode: Bool

    /// A non-chat mode needs the opencode session id to be saved against. A
    /// legacy box answers without one: the shell still opens (a plain terminal)
    /// — never a silent drop.
    static func make(mode: SessionMode, sessionId: String?) -> SessionCreateLanding {
        let sid = (sessionId ?? "").isEmpty ? nil : sessionId
        switch mode {
        case .chat:
            return SessionCreateLanding(mode: .chat, sessionId: sid, writesMode: false)
        case .terminal, .cli:
            guard let sid else { return SessionCreateLanding(mode: .terminal, sessionId: nil, writesMode: false) }
            return SessionCreateLanding(mode: mode, sessionId: sid, writesMode: true)
        }
    }
}

/// A finished create, as the sheet hands it to its owner.
struct SessionCreated: Equatable, Sendable {
    var project: String
    var windowIndex: Int
    var sessionId: String?
    /// The box's post-create project list.
    var projects: [MantaProject]
    var mode: SessionMode
    /// The draft after "Don't carry over" was applied.
    var draft: NewSessionDraft?
}

enum SessionCreatedWindow {
    /// The window the box just created, and the project it really lives in.
    ///
    /// By the index it reported (the only reliable key — names collide), else by
    /// name, else the project's last window. When no project carries the name we
    /// asked for (tmux rewrote it), the window whose opencode session id the box
    /// reported is found across ALL projects, and ITS project name is returned —
    /// the name to put in the navigation value, not the one we sent.
    static func locate(in projects: [MantaProject], project: String, windowIndex: Int?, sessionId: String?,
                       name: String?) -> (project: String, window: MantaWindow)? {
        // The project name is the one the box reported (tmux-safe and unique already).
        if let proj = projects.first(where: { $0.tmuxSession == project }),
           let window = pick(in: proj, windowIndex: windowIndex, name: name) {
            return (proj.tmuxSession, window)
        }
        if let sessionId, !sessionId.isEmpty {
            for proj in projects {
                if let window = proj.windows.first(where: { $0.opencodeSessionId == sessionId }) {
                    return (proj.tmuxSession, window)
                }
            }
        }
        return nil
    }

    /// Same, for callers that only need the window.
    static func find(in projects: [MantaProject], project: String, windowIndex: Int?, name: String?,
                     sessionId: String? = nil) -> MantaWindow? {
        locate(in: projects, project: project, windowIndex: windowIndex, sessionId: sessionId, name: name)?.window
    }

    private static func pick(in proj: MantaProject, windowIndex: Int?, name: String?) -> MantaWindow? {
        if let windowIndex, let byIndex = proj.windows.first(where: { $0.index == windowIndex }) { return byIndex }
        if let name, let byName = proj.windows.first(where: { $0.name == name }) { return byName }
        return proj.windows.last
    }
}

// MARK: - Draft prefill (D2 / D11 / D12)

struct SessionCreatePrefill: Equatable, Sendable {
    enum Target: Equatable, Sendable {
        /// The draft named no folder: keep the sheet's own default.
        case unspecified
        case existing(project: String)
        /// The folder is not under any known project.
        case newProjectFolder
    }

    var target: Target
    var folder: String?
    var worktreeOn: Bool
    var worktreeBranch: String
    var linkedIssueURL: String?
}

enum SessionDraftPrefill {
    /// Where a draft's `cwd` belongs, and the worktree choice it implies.
    ///
    /// `cwd` matches a project when it equals, or sits under, that project's
    /// `defaultCwd` or any window's `paneCurrentPath` (longest match wins; `/a/bc`
    /// is not under `/a/b`). A draft `worktreeBranch` pre-ticks the worktree with
    /// THAT branch and wins over the box's `worktreePerSession` default; without
    /// one the default is the box's for an existing project and off for a new one.
    static func apply(draft: NewSessionDraft, projects: [MantaProject], worktreePerSession: Bool) -> SessionCreatePrefill {
        var target = SessionCreatePrefill.Target.unspecified
        var folder: String?
        if let cwd = draft.cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cwd.isEmpty {
            folder = cwd
            if let project = bestProject(for: cwd, in: projects) {
                target = .existing(project: project)
            } else {
                target = .newProjectFolder
            }
        }
        var worktreeOn: Bool
        var branch = SessionWorktreeDefaults.branch
        if let requested = draft.worktreeBranch?.trimmingCharacters(in: .whitespacesAndNewlines), !requested.isEmpty {
            worktreeOn = true
            branch = requested
        } else if target == .newProjectFolder {
            worktreeOn = false
        } else {
            worktreeOn = worktreePerSession
        }
        let issue = draft.linkedIssueURL?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SessionCreatePrefill(
            target: target,
            folder: folder,
            worktreeOn: worktreeOn,
            worktreeBranch: branch,
            linkedIssueURL: (issue?.isEmpty ?? true) ? nil : issue
        )
    }

    private static func bestProject(for cwd: String, in projects: [MantaProject]) -> String? {
        var best: (name: String, length: Int)?
        for project in projects {
            var candidates = [project.defaultCwd]
            candidates += project.windows.map(\.paneCurrentPath)
            for raw in candidates {
                var path = raw
                while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
                guard !path.isEmpty else { continue }
                let matches = cwd == path || cwd.hasPrefix(path == "/" ? "/" : path + "/")
                guard matches else { continue }
                if best == nil || path.count > best?.length ?? 0 {
                    best = (project.tmuxSession, path.count)
                }
            }
        }
        return best?.name
    }
}

// MARK: - Repository scan (§5)

enum RepoZeroState: Equatable, Sendable {
    case scanning, degraded, fresh, list

    /// "Probe succeeded but found nothing" is `fresh`, never `degraded`: an empty
    /// box invites a clone, a failed scan degrades to the folder picker.
    static func mode(pending: Bool, failed: Bool, repos: [RepoHit]) -> RepoZeroState {
        if pending { return .scanning }
        if failed { return .degraded }
        return repos.isEmpty ? .fresh : .list
    }
}

enum RepoRowFormat {
    /// The box's home directory shown as `~`.
    static func homeRelative(_ path: String, homeDir: String?) -> String {
        guard let homeDir, !homeDir.isEmpty, !path.isEmpty else { return path }
        if path == homeDir { return "~" }
        let prefix = homeDir.hasSuffix("/") ? homeDir : homeDir + "/"
        return path.hasPrefix(prefix) ? "~/" + path.dropFirst(prefix.count) : path
    }

    /// The line under a repo row. With an origin the branch alone identifies the
    /// row; without one the bare basename does not, so the path and "no remote"
    /// are added.
    static func secondary(_ repo: RepoHit, homeDir: String?) -> String {
        let branch = (repo.branch ?? "").isEmpty ? "no branch" : "⎇ \(repo.branch ?? "")"
        if (repo.originUrl ?? "").isEmpty {
            return "\(branch) · \(homeRelative(repo.path, homeDir: homeDir)) · no remote"
        }
        return branch
    }

    /// Port of `formatAge`: elapsed milliseconds → "now" / "Nm" / "Nh" / "Nd".
    static func age(ms: Double) -> String {
        guard ms.isFinite, ms >= 60_000 else { return "now" }
        let minutes = Int(ms / 60_000)
        if minutes < 60 { return "\(minutes)m" }
        let hours = Int(ms / 3_600_000)
        if hours < 24 { return "\(hours)h" }
        return "\(Int(ms / 86_400_000))d"
    }
}

// MARK: - Batch set-up (§5)

enum SessionSetupRowPhase: Equatable, Sendable {
    case queued, creating, ready, failed
}

/// "Set up N workspaces": one `tmux:new-session` per checked repository, in
/// order, with a status per row.
struct SessionSetupBatch: Equatable, Sendable {
    struct Row: Equatable, Sendable {
        var path: String
        /// The repository folder's basename, as a label.
        var name: String
        var phase: SessionSetupRowPhase = .queued
        var error: String?
    }

    private(set) var rows: [Row]

    /// One row per repository. The row's `name` is its folder's basename (a label); the box names each
    /// session — tmux-safe and unique across the batch and the existing projects (WS11 D5 / S1).
    init(paths: [String]) {
        self.rows = paths.map { Row(path: $0, name: SessionNaming.deriveProjectName($0)) }
    }

    /// Index of the next row to run, in order.
    var nextQueuedIndex: Int? { rows.firstIndex { $0.phase == .queued } }
    var isRunning: Bool { rows.contains { $0.phase == .queued || $0.phase == .creating } }
    var allReady: Bool { !rows.isEmpty && rows.allSatisfy { $0.phase == .ready } }
    var hasFailures: Bool { rows.contains { $0.phase == .failed } }

    /// The repository to open automatically: only when EVERY row succeeded, the
    /// first one in batch order.
    var autoLandingPath: String? { allReady ? rows.first?.path : nil }
    /// Where "Done" lands after a partial failure: the first success, if any.
    var doneLandingPath: String? { rows.first { $0.phase == .ready }?.path }

    mutating func markCreating(at index: Int) {
        guard rows.indices.contains(index) else { return }
        rows[index].phase = .creating
        rows[index].error = nil
    }

    mutating func markReady(path: String) {
        guard let i = rows.firstIndex(where: { $0.path == path }) else { return }
        rows[i].phase = .ready
        rows[i].error = nil
    }

    mutating func markFailed(path: String, message: String) {
        guard let i = rows.firstIndex(where: { $0.path == path }) else { return }
        rows[i].phase = .failed
        rows[i].error = message
    }

    /// Rows caught mid-create when the batch was cancelled become failed (with
    /// `message`), so none is left showing "Creating…" with nothing running.
    mutating func failCreating(message: String) {
        for i in rows.indices where rows[i].phase == .creating {
            rows[i].phase = .failed
            rows[i].error = message
        }
    }

    /// Puts a failed row back in the queue.
    mutating func requeue(path: String) {
        guard let i = rows.firstIndex(where: { $0.path == path }), rows[i].phase == .failed else { return }
        rows[i].phase = .queued
        rows[i].error = nil
    }
}
