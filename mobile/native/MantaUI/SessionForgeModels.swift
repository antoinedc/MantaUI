import Foundation

// ===========================================================================
// WS04 — wire types for the session-creation, GitHub and stopped-conversation
// channels (spec 04-sessions §13). Foundation-only so they build in the Linux
// SwiftPM package (D19). Every shape mirrors what `src/server/*` answers, and
// every decoder is lenient about an optional field a newer or older box may
// add, drop or null: a record that fails to decode is a feature that silently
// disappears.
// ===========================================================================

// MARK: - fs / git / project

/// One sub-folder of a listed directory (`fs:list-dirs`).
struct SessionDirEntry: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    /// Absolute path (the box expands `~` before answering).
    var path: String
    /// A dot-folder. The desktop picker filters these out.
    var hidden: Bool

    var id: String { path }

    private enum CodingKeys: String, CodingKey { case name, path, hidden }

    init(name: String, path: String, hidden: Bool) {
        self.name = name
        self.path = path
        self.hidden = hidden
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        path = try c.decode(String.self, forKey: .path)
        hidden = ((try? c.decodeIfPresent(Bool.self, forKey: .hidden)) ?? nil) ?? name.hasPrefix(".")
    }
}

/// The `fs:list-dirs` reply: `{dir, entries}`. (The old iOS client decoded it as
/// `[String]`, which can never succeed — bug B1.)
struct SessionDirListing: Decodable, Equatable, Sendable {
    var dir: String
    var entries: [SessionDirEntry]

    private enum CodingKeys: String, CodingKey { case dir, entries }

    init(dir: String, entries: [SessionDirEntry]) {
        self.dir = dir
        self.entries = entries
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dir = try c.decode(String.self, forKey: .dir)
        entries = ((try? c.decodeIfPresent([SessionDirEntry].self, forKey: .entries)) ?? nil) ?? []
    }

    /// The folders a picker shows: dot-folders removed, in the box's order.
    var visibleEntries: [SessionDirEntry] { entries.filter { !$0.hidden } }
}

/// `git:add-worktree` → `{path, branch}` (the box slugifies and de-duplicates
/// the branch and places the worktree next to the repository).
struct SessionWorktreeAdded: Decodable, Equatable, Sendable {
    var path: String
    var branch: String
}

/// `git:remove-worktree` → `{removed, reason?}`. A dirty checkout is
/// `{removed:false, reason:"dirty"}`; every other failure THROWS (the store maps
/// that to `.otherFailure`).
struct SessionWorktreeRemoval: Decodable, Equatable, Sendable {
    var removed: Bool
    var reason: String?

    init(removed: Bool, reason: String? = nil) {
        self.removed = removed
        self.reason = reason
    }

    var isDirty: Bool { !removed && reason == "dirty" }

    /// Stand-in for a removal that threw something other than "dirty".
    static let otherFailure = SessionWorktreeRemoval(removed: false, reason: "other")
}

/// `project:create-scratch` → `{path, name}`.
struct SessionScratchProject: Decodable, Equatable, Sendable {
    var path: String
    var name: String
}

// MARK: - forge:probe

struct ForgeCliStatus: Decodable, Equatable, Sendable {
    var installed: Bool
    var authenticated: Bool
    var login: String?

    init(installed: Bool = false, authenticated: Bool = false, login: String? = nil) {
        self.installed = installed
        self.authenticated = authenticated
        self.login = login
    }

    private enum CodingKeys: String, CodingKey { case installed, authenticated, login }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = ((try? c.decodeIfPresent(Bool.self, forKey: .installed)) ?? nil) ?? false
        authenticated = ((try? c.decodeIfPresent(Bool.self, forKey: .authenticated)) ?? nil) ?? false
        login = (try? c.decodeIfPresent(String.self, forKey: .login)) ?? nil
    }
}

/// A repository the box found on disk.
struct RepoHit: Decodable, Equatable, Sendable, Identifiable {
    var path: String
    var name: String
    var branch: String?
    var originUrl: String?
    var forge: String?
    var repoKey: String?
    /// Epoch milliseconds (approximate: the mtime of `.git/HEAD`).
    var lastCommitAt: Double?

    var id: String { path }

    init(path: String, name: String, branch: String? = nil, originUrl: String? = nil,
         forge: String? = nil, repoKey: String? = nil, lastCommitAt: Double? = nil) {
        self.path = path
        self.name = name
        self.branch = branch
        self.originUrl = originUrl
        self.forge = forge
        self.repoKey = repoKey
        self.lastCommitAt = lastCommitAt
    }

    private enum CodingKeys: String, CodingKey {
        case path, name, branch, originUrl, forge, repoKey, lastCommitAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil)
            ?? SessionNaming.deriveProjectName(path)
        branch = (try? c.decodeIfPresent(String.self, forKey: .branch)) ?? nil
        originUrl = (try? c.decodeIfPresent(String.self, forKey: .originUrl)) ?? nil
        forge = (try? c.decodeIfPresent(String.self, forKey: .forge)) ?? nil
        repoKey = (try? c.decodeIfPresent(String.self, forKey: .repoKey)) ?? nil
        lastCommitAt = (try? c.decodeIfPresent(Double.self, forKey: .lastCommitAt)) ?? nil
    }
}

/// `forge:probe` → `{repos, cli, partial, homeDir}`.
struct ForgeProbeResult: Decodable, Equatable, Sendable {
    var repos: [RepoHit]
    var cli: ForgeCliStatus
    var partial: Bool
    var homeDir: String?
    /// Where new workspaces go, decided by the box (WS11 D5 / S3). nil on an older box.
    var proposedRoot: String?

    init(repos: [RepoHit], cli: ForgeCliStatus = ForgeCliStatus(), partial: Bool = false, homeDir: String? = nil, proposedRoot: String? = nil) {
        self.repos = repos
        self.cli = cli
        self.partial = partial
        self.homeDir = homeDir
        self.proposedRoot = proposedRoot
    }

    private enum CodingKeys: String, CodingKey { case repos, cli, partial, homeDir, proposedRoot }

    /// Decodes anything and consumes exactly one element, so a malformed repo is
    /// stepped over instead of failing the whole scan.
    private struct LossyRepo: Decodable {
        let hit: RepoHit?
        init(from decoder: Decoder) throws { hit = try? RepoHit(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repos = (((try? c.decodeIfPresent([LossyRepo].self, forKey: .repos)) ?? nil) ?? []).compactMap(\.hit)
        cli = ((try? c.decodeIfPresent(ForgeCliStatus.self, forKey: .cli)) ?? nil) ?? ForgeCliStatus()
        partial = ((try? c.decodeIfPresent(Bool.self, forKey: .partial)) ?? nil) ?? false
        homeDir = (try? c.decodeIfPresent(String.self, forKey: .homeDir)) ?? nil
        proposedRoot = (try? c.decodeIfPresent(String.self, forKey: .proposedRoot)) ?? nil
    }
}

/// `sessions:propose-name` — a preview of the name a create would pick (WS11 D5 / S1). `hint` is the one
/// line under a scratch name ("Add at least one letter or number…" / "x already exists — will create x-2").
struct SessionNameProposal: Decodable, Equatable, Sendable {
    var name: String
    var hint: String?
}

// MARK: - GitHub device sign-in

/// The renderer-safe device grant (`device_code` never reaches a client).
struct GitHubDeviceGrant: Decodable, Equatable, Sendable {
    var grantId: String
    var userCode: String
    var verificationUri: String
    /// Seconds until the code stops working.
    var expiresIn: Int
    /// Seconds between polls the server asks for.
    var pollInterval: Int

    init(grantId: String, userCode: String, verificationUri: String, expiresIn: Int, pollInterval: Int) {
        self.grantId = grantId
        self.userCode = userCode
        self.verificationUri = verificationUri
        self.expiresIn = expiresIn
        self.pollInterval = pollInterval
    }

    private enum CodingKeys: String, CodingKey {
        case grantId, userCode, verificationUri, expiresIn, pollInterval
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        grantId = try c.decode(String.self, forKey: .grantId)
        userCode = try c.decode(String.self, forKey: .userCode)
        verificationUri = try c.decode(String.self, forKey: .verificationUri)
        expiresIn = Int(try c.decode(Double.self, forKey: .expiresIn).rounded())
        pollInterval = Int(try c.decode(Double.self, forKey: .pollInterval).rounded())
    }
}

/// `forge:device-start`. Three shapes:
/// `{connected:true, grant:null}`, `{connected:false, grant, error:null}` and
/// `{connected:false, notConfigured:true, grant:null}`.
struct GitHubDeviceStart: Decodable, Equatable, Sendable {
    var connected: Bool
    var notConfigured: Bool
    var grant: GitHubDeviceGrant?
    var error: String?

    init(connected: Bool = false, notConfigured: Bool = false, grant: GitHubDeviceGrant? = nil, error: String? = nil) {
        self.connected = connected
        self.notConfigured = notConfigured
        self.grant = grant
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case connected, notConfigured, grant, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = ((try? c.decodeIfPresent(Bool.self, forKey: .connected)) ?? nil) ?? false
        notConfigured = ((try? c.decodeIfPresent(Bool.self, forKey: .notConfigured)) ?? nil) ?? false
        grant = (try? c.decodeIfPresent(GitHubDeviceGrant.self, forKey: .grant)) ?? nil
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
    }
}

/// `forge:device-poll`. Four shapes: `{status:"pending", pollInterval}`,
/// `{status:"done"}`, `{status:"expired"}`, `{status:"error", error}`.
struct GitHubDevicePoll: Decodable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case pending, done, expired, error
        /// A status a newer box invented. Counted as an error, never as "done".
        case unknown(String)
    }

    var status: String
    var pollInterval: Int?
    var error: String?

    init(status: String, pollInterval: Int? = nil, error: String? = nil) {
        self.status = status
        self.pollInterval = pollInterval
        self.error = error
    }

    var kind: Kind {
        switch status {
        case "pending": return .pending
        case "done": return .done
        case "expired": return .expired
        case "error": return .error
        default: return .unknown(status)
        }
    }

    private enum CodingKeys: String, CodingKey { case status, pollInterval, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(String.self, forKey: .status)
        if let n = (try? c.decodeIfPresent(Double.self, forKey: .pollInterval)) ?? nil {
            pollInterval = Int(n.rounded())
        } else {
            pollInterval = nil
        }
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
    }
}

// MARK: - GitHub repos + clone

struct GitHubRepo: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var fullName: String
    var owner: String
    var description: String?
    /// Epoch milliseconds.
    var pushedAt: Double?
    var defaultBranch: String
    var cloneUrl: String
    var url: String

    var id: String { fullName }

    init(name: String, fullName: String, owner: String, description: String? = nil, pushedAt: Double? = nil,
         defaultBranch: String = "main", cloneUrl: String = "", url: String = "") {
        self.name = name
        self.fullName = fullName
        self.owner = owner
        self.description = description
        self.pushedAt = pushedAt
        self.defaultBranch = defaultBranch
        self.cloneUrl = cloneUrl
        self.url = url
    }

    private enum CodingKeys: String, CodingKey {
        case name, fullName, owner, description, pushedAt, defaultBranch, cloneUrl, url
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        fullName = try c.decode(String.self, forKey: .fullName)
        owner = ((try? c.decodeIfPresent(String.self, forKey: .owner)) ?? nil) ?? ""
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil
        pushedAt = (try? c.decodeIfPresent(Double.self, forKey: .pushedAt)) ?? nil
        defaultBranch = ((try? c.decodeIfPresent(String.self, forKey: .defaultBranch)) ?? nil) ?? "main"
        cloneUrl = ((try? c.decodeIfPresent(String.self, forKey: .cloneUrl)) ?? nil) ?? ""
        url = ((try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil) ?? ""
    }
}

/// `forge:repos` → `{repos, stale, error?}`. `error` is a machine code
/// (`not_connected`, `rejected`, `rate_limited`, `forbidden`, `network`) or a
/// raw exception string — never shown verbatim (`RepoListError.message`).
struct GitHubRepoList: Decodable, Equatable, Sendable {
    var repos: [GitHubRepo]
    var stale: Bool
    var error: String?

    init(repos: [GitHubRepo], stale: Bool = false, error: String? = nil) {
        self.repos = repos
        self.stale = stale
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case repos, stale, error }

    private struct LossyRepo: Decodable {
        let repo: GitHubRepo?
        init(from decoder: Decoder) throws { repo = try? GitHubRepo(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repos = (((try? c.decodeIfPresent([LossyRepo].self, forKey: .repos)) ?? nil) ?? []).compactMap(\.repo)
        stale = ((try? c.decodeIfPresent(Bool.self, forKey: .stale)) ?? nil) ?? false
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
    }
}

/// `forge:clone-start` → `{id}` on success; `{error, message?}` when the
/// destination preflight (or the request) was refused.
struct CloneStartResult: Decodable, Equatable, Sendable {
    var id: String?
    var error: String?
    var message: String?

    init(id: String? = nil, error: String? = nil, message: String? = nil) {
        self.id = id
        self.error = error
        self.message = message
    }

    private enum CodingKeys: String, CodingKey { case id, error, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? nil
    }
}

/// `forge:clone-status` → the job snapshot, or `null` once the box forgot it.
struct CloneJobStatus: Decodable, Equatable, Sendable {
    var id: String
    var name: String
    var url: String
    var dest: String
    /// 0…100.
    var percent: Double
    var bytes: Double
    var done: Bool
    var ok: Bool
    var error: String?
    var cancelled: Bool

    init(id: String, name: String = "", url: String = "", dest: String = "", percent: Double = 0, bytes: Double = 0,
         done: Bool = false, ok: Bool = false, error: String? = nil, cancelled: Bool = false) {
        self.id = id
        self.name = name
        self.url = url
        self.dest = dest
        self.percent = percent
        self.bytes = bytes
        self.done = done
        self.ok = ok
        self.error = error
        self.cancelled = cancelled
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, url, dest, percent, bytes, done, ok, error, cancelled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? ""
        url = ((try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil) ?? ""
        dest = ((try? c.decodeIfPresent(String.self, forKey: .dest)) ?? nil) ?? ""
        percent = ((try? c.decodeIfPresent(Double.self, forKey: .percent)) ?? nil) ?? 0
        bytes = ((try? c.decodeIfPresent(Double.self, forKey: .bytes)) ?? nil) ?? 0
        done = ((try? c.decodeIfPresent(Bool.self, forKey: .done)) ?? nil) ?? false
        ok = ((try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil) ?? false
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        cancelled = ((try? c.decodeIfPresent(Bool.self, forKey: .cancelled)) ?? nil) ?? false
    }
}

// MARK: - Stopped conversations (usage-stopped:list)

/// One conversation stopped by a plan-usage limit (`src/server/stoppedStore.mjs`).
/// Property names are the wire keys.
struct SessionStoppedRecord: Decodable, Equatable, Sendable, Identifiable {
    var workspace: String
    var conversation: String
    var provider: String
    var model: String?
    var window: String?
    /// Epoch milliseconds.
    var stoppedAt: Double
    var cachedTokens: Double?
    var armed: Bool?
    var attempts: Int?

    var id: String { conversation }

    init(workspace: String, conversation: String, provider: String, model: String? = nil, window: String? = nil,
         stoppedAt: Double, cachedTokens: Double? = nil, armed: Bool? = nil, attempts: Int? = nil) {
        self.workspace = workspace
        self.conversation = conversation
        self.provider = provider
        self.model = model
        self.window = window
        self.stoppedAt = stoppedAt
        self.cachedTokens = cachedTokens
        self.armed = armed
        self.attempts = attempts
    }

    private enum CodingKeys: String, CodingKey {
        case workspace, conversation, provider, model, window, stoppedAt, cachedTokens, armed, attempts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversation = try c.decode(String.self, forKey: .conversation)
        stoppedAt = try c.decode(Double.self, forKey: .stoppedAt)
        workspace = ((try? c.decodeIfPresent(String.self, forKey: .workspace)) ?? nil) ?? ""
        provider = ((try? c.decodeIfPresent(String.self, forKey: .provider)) ?? nil) ?? ""
        model = (try? c.decodeIfPresent(String.self, forKey: .model)) ?? nil
        window = (try? c.decodeIfPresent(String.self, forKey: .window)) ?? nil
        cachedTokens = (try? c.decodeIfPresent(Double.self, forKey: .cachedTokens)) ?? nil
        armed = (try? c.decodeIfPresent(Bool.self, forKey: .armed)) ?? nil
        attempts = (try? c.decodeIfPresent(Int.self, forKey: .attempts)) ?? nil
    }
}

/// `usage-stopped:list` → `{records, lastLooked}`. `lastLooked` is epoch
/// milliseconds, exactly as sent (compare with `stoppedAt`, same units).
struct SessionStoppedList: Decodable, Equatable, Sendable {
    var records: [SessionStoppedRecord]
    var lastLooked: Double?

    init(records: [SessionStoppedRecord] = [], lastLooked: Double? = nil) {
        self.records = records
        self.lastLooked = lastLooked
    }

    private enum CodingKeys: String, CodingKey { case records, lastLooked }

    private struct LossyRecord: Decodable {
        let record: SessionStoppedRecord?
        init(from decoder: Decoder) throws { record = try? SessionStoppedRecord(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        records = (((try? c.decodeIfPresent([LossyRecord].self, forKey: .records)) ?? nil) ?? []).compactMap(\.record)
        lastLooked = (try? c.decodeIfPresent(Double.self, forKey: .lastLooked)) ?? nil
    }
}

// MARK: - Create inputs

/// `tmux:new-session` — a new project (a tmux session) with its first window.
struct SessionNewProjectInput: Equatable, Sendable {
    /// An explicit name (the box makes it tmux-safe but never renames it). nil = the box names the
    /// session from `nameHint` (tmux-safe, unique, allocated under a lock) — WS11 D5 / S1.
    var name: String? = nil
    var nameHint: String? = nil
    var cwd: String
    var windowName: String
    var chatMode: Bool
    var createDir: Bool
}

/// `tmux:new-window` — a new session in an existing project. `worktreePath`
/// stamps the window so clean-on-close can find the worktree later.
struct SessionNewWindowInput: Equatable, Sendable {
    var sessionName: String
    var windowName: String
    var cwd: String?
    var chatMode: Bool
    var worktreePath: String? = nil
}
