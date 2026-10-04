import Foundation

// ===========================================================================
// S3 — session-list models + pure logic (BET-595).
//
// Implements DECISIONS.md §7. The list is grouped by project (a tmux
// session); each row is a window (a session). The Codable models match the
// server `tmux:list` / `git:list-worktrees` shapes exactly. The presentation
// and behaviour helpers are PURE (no HTTP/view/Keychain) so the list's
// decisions — subtitle per §7.1a, dot colour §7.1, delete semantics §7.3,
// haptics §7.4, folder browsing, pin identity — are unit-testable.
//
// No colour/spacing/radius/size/weight literal appears in app code; every
// value resolves through the generated tokens in the views.
// ===========================================================================
//
// The design-token contract the views consume (off the spacing/type grid):
//   Metrics.type.rowName        — row name 15.5px (§7.1)
//   Metrics.type.headingTracking / rowNameTracking — unitless em trackings
//   Metrics.type.twoXS          — timer 11px (§7.1)
//   Metrics.type.xs             — subtitle 12px (§7.1)
//   Metrics.type.body           — group header 15px/600 (§7.1)
//   Metrics.spacing.sp3         — row / group-header padding-left 12 (§7.1)
//   Metrics.type.listRowMinH    — row min height 62 (§7.1)
//   Metrics.type.listRowRadius  — row radius 20 (§7.1)
//   Metrics.type.listRowMargin  — row margin-bottom 2 (§7.1)
//   Metrics.type.listGroupAbove — group header 22px above (§7.1)
//   Metrics.type.listGroupBelow — group header 6px below (§7.1)
// The timer is rendered MONO and tabular (SwiftUI `.monospacedDigit()`).

// MARK: - Server shapes (tmux:list / git:list-worktrees)

struct MantaWindow: Codable, Equatable, Sendable, Identifiable {
    var index: Int
    var name: String
    var active: Bool
    var paneCurrentPath: String
    var opencodeSessionId: String?
    var worktreePath: String?
    /// Who owns the window, from the tmux `@manta-owner` stamp: `"user"`,
    /// `"cto"` or `"job"` (src/server/tmux.mjs). Absent on a box that predates
    /// the stamp, which reads as a plain user window.
    var owner: String? = nil

    var id: Int { index }

    /// The box tagged this window as a background job's own window. This is the
    /// primary job-window signal; the job-record nesting rule only backstops
    /// windows created before the tag existed.
    var isJobWindow: Bool { owner == "job" }

    /// A chat-mode window — one backed by an opencode session. A window with no
    /// session is a terminal window.
    var hasChatSession: Bool { !(opencodeSessionId ?? "").isEmpty }
}

struct MantaProject: Codable, Equatable, Sendable, Identifiable {
    var tmuxSession: String
    var defaultCwd: String
    var windows: [MantaWindow]
    var attached: Bool
    var mantaOwned: Bool?

    var id: String { tmuxSession }
}

struct MantaWorktree: Codable, Equatable, Sendable {
    var path: String
    var head: String
    var branch: String?
    var bare: Bool
    var detached: Bool
}

// MARK: - Background jobs (BET-1213)

/// A background-delegation job record, mirrored from the box's `delegate:list`
/// channel. One fetch covers BOTH kinds the box's job store adopts: a `delegate`
/// job, and a `task` subagent launched with `background: true`
/// (src/server/delegate.mjs). `parentSessionID` is the session that started the
/// job; `childSessionID` is the job's own opencode session (null until created).
/// Unknown fields are ignored by Codable.
///
/// Only `id` and `status` are required. Everything else is optional AND decoded
/// leniently (`init(from:)` in the extension below): a field of an unexpected
/// type becomes nil instead of failing the record, because a record that fails
/// to decode is dropped from the list and its job vanishes from the UI.
struct DelegateJob: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var parentSessionID: String?
    var childSessionID: String?
    var status: String
    /// Display name the box gave the job (the delegate prompt's title, or the
    /// task's description).
    var name: String? = nil
    /// `"delegate"` for a `delegate` job, `"subagent"` for a `task` subagent the
    /// job store adopted.
    var origin: String? = nil
    var branch: String? = nil
    /// One line describing what the job is doing now (box-generated).
    var activity: String? = nil
    /// Epoch milliseconds, as the box stores them.
    var createdAt: Double? = nil
    var startedAt: Double? = nil
    var finishedAt: Double? = nil

    fileprivate enum CodingKeys: String, CodingKey {
        case id, parentSessionID, childSessionID, status
        case name, origin, branch, activity
        case createdAt, startedAt, finishedAt
    }

    /// Whether the job is still live. `done`/`failed`/`stopped` are terminal;
    /// anything else (a running job, or a status a newer box added) counts as
    /// active so the count never under-reports a live job.
    var isActive: Bool {
        status != "done" && status != "failed" && status != "stopped"
    }

    /// Whether the job can be stopped: the box's `stopJob` accepts a running
    /// job and a paused one, and nothing else.
    var isStoppable: Bool { status == "running" || status == "paused" }
}

extension DelegateJob {
    // In an extension so the synthesized memberwise initializer survives — the
    // existing call sites build jobs with `DelegateJob(id:parentSessionID:…)`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(String.self, forKey: .status)
        parentSessionID = Self.lenientString(c, .parentSessionID)
        childSessionID = Self.lenientString(c, .childSessionID)
        name = Self.lenientString(c, .name)
        origin = Self.lenientString(c, .origin)
        branch = Self.lenientString(c, .branch)
        activity = Self.lenientString(c, .activity)
        createdAt = Self.lenientMillis(c, .createdAt)
        startedAt = Self.lenientMillis(c, .startedAt)
        finishedAt = Self.lenientMillis(c, .finishedAt)
    }

    private static func lenientString(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil
    }

    /// A number (the box's shape), or a numeric string from a looser writer.
    private static func lenientMillis(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Double? {
        if let n = (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil { return n }
        if let s = (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil { return Double(s) }
        return nil
    }
}

/// The `delegate:list` result, decoded one record at a time.
///
/// Accepts both shapes the box answers with — a bare `DelegateJob[]`, and the
/// no-engine fallback `{ jobs: [] }` — and SKIPS a record that will not decode
/// rather than failing the whole list. A single malformed job used to throw out
/// every job, which un-hid every background-job window in the session list.
struct LenientDelegateJobs: Decodable, Sendable {
    let jobs: [DelegateJob]

    private enum Keys: String, CodingKey { case jobs }

    /// Decodes anything and consumes exactly one element, which is how a
    /// failed element is stepped over: an unkeyed container's index only
    /// advances on a SUCCESSFUL decode, so a throwing element would otherwise
    /// be retried forever.
    private struct Skip: Decodable {}

    init(from decoder: Decoder) throws {
        if var bare = try? decoder.unkeyedContainer() {
            jobs = Self.records(from: &bare)
            return
        }
        let keyed = try decoder.container(keyedBy: Keys.self)
        guard keyed.contains(.jobs), var nested = try? keyed.nestedUnkeyedContainer(forKey: .jobs) else {
            jobs = []
            return
        }
        jobs = Self.records(from: &nested)
    }

    private static func records(from container: inout UnkeyedDecodingContainer) -> [DelegateJob] {
        var out: [DelegateJob] = []
        while !container.isAtEnd {
            if let job = try? container.decode(DelegateJob.self) {
                out.append(job)
                continue
            }
            // Step over the bad record. If even that fails, stop rather than
            // spin: the container did not advance.
            do { _ = try container.decode(Skip.self) } catch { break }
        }
        return out
    }
}

/// Which windows are background-job windows, and what the session list should
/// therefore render (spec §2).
///
/// A window is a job window when the box tagged it `owner == "job"` OR the
/// job-record nesting rule hides it (covers windows created before the tag
/// existed). Job windows are never top-level rows. A job window whose parent is
/// visible is represented by its parent's count; one with NO visible parent
/// (parent closed, in another project, headless, or the job record pruned) is
/// hidden entirely — it is reachable only from the parent's Background jobs
/// sheet, never from the list.
enum SessionJobWindows {
    /// Indices of a project's windows to REMOVE from the list.
    static func hiddenIndices(project: MantaProject, jobs: [DelegateJob]) -> Set<Int> {
        hiddenIndices(project: project, nesting: SessionJobNesting.compute(project: project, jobs: jobs))
    }

    /// Same, for a caller that already computed the nesting (it also needs the
    /// per-parent counts) and should not compute it twice.
    static func hiddenIndices(project: MantaProject, nesting: DelegateNesting) -> Set<Int> {
        var hidden = nesting.hidden
        for w in project.windows where w.isJobWindow {
            hidden.insert(w.index)
        }
        return hidden
    }

    /// `projects` with each project's hidden windows removed. A project left
    /// with no windows because ALL of them were job windows is dropped (its
    /// header would head an empty card); a project that never had windows is
    /// kept as it was.
    static func visible(_ projects: [MantaProject], hidden: [String: Set<Int>]) -> [MantaProject] {
        projects.compactMap { project in
            guard let drop = hidden[project.tmuxSession], !drop.isEmpty else { return project }
            var copy = project
            copy.windows = project.windows.filter { !drop.contains($0.index) }
            if copy.windows.isEmpty && !project.windows.isEmpty { return nil }
            return copy
        }
    }
}

/// Result of nesting a project's windows against its jobs (BET-1213).
struct DelegateNesting: Equatable, Sendable {
    /// Child window indices to REMOVE from the project's top-level rows.
    var hidden: Set<Int>
    /// Parent window index -> count of non-terminal jobs nested under it.
    var activeChildCounts: [Int: Int]
}

/// Pure port of the desktop `computeJobNesting` (src/renderer/chatUtils.ts).
/// For each job whose child window AND parent window both exist in the project,
/// the child window is hidden — on mobile it renders as NO row of its own; the
/// parent row carries the background-job count instead (no nested row, no
/// disclosure). A job whose parent window is gone leaves the child VISIBLE at
/// top level (never orphan a reachable session). A job whose child window is
/// absent is ignored.
enum SessionJobNesting {
    static func compute(project: MantaProject, jobs: [DelegateJob]) -> DelegateNesting {
        var hidden = Set<Int>()
        var counts: [Int: Int] = [:]
        var byOpencodeId: [String: MantaWindow] = [:]
        for w in project.windows {
            if let sid = w.opencodeSessionId, !sid.isEmpty {
                byOpencodeId[sid] = w
            }
        }
        for job in jobs {
            guard let child = job.childSessionID, !child.isEmpty,
                  let childWin = byOpencodeId[child] else { continue }
            guard let parent = job.parentSessionID, !parent.isEmpty,
                  let parentWin = byOpencodeId[parent] else { continue }
            hidden.insert(childWin.index)
            if job.isActive {
                counts[parentWin.index, default: 0] += 1
            }
        }
        return DelegateNesting(hidden: hidden, activeChildCounts: counts)
    }
}

/// The durable, session-scoped "where is this turn right now" record (BET-790,
/// mirroring src/server/progress.mjs). One record per session; `step` is
/// monotonic and clamped server-side. The list surface reads only the model's
/// working `label`; the rest rides along for future surfaces.
struct MantaProgress: Codable, Equatable, Sendable {
    var sessionID: String
    var label: String
    var step: Int?
    var total: Int?
    var state: String
    var detail: String
    var updatedAt: Int

    /// The model-authored label only while the turn is genuinely `working` —
    /// `blocked` yields to its card, `done`/`failed` to the turn ending.
    var workingLabel: String? {
        state == "working" && !label.isEmpty ? label : nil
    }
}

/// Create-input payload for `tmux:new-session` (a new project).
struct NewSessionInput: Sendable {
    var name: String
    var cwd: String
    var windowName: String
    var createDir: Bool
    var chatMode: Bool
}

/// Create-input payload for `tmux:new-window` (a new session in a project).
struct NewWindowInput: Sendable {
    var sessionName: String
    var windowName: String
    var cwd: String?
    var chatMode: Bool
}

/// The reply from `tmux:new-session` / `tmux:new-window`.
///
/// The box answers `{sessionId, windowIndex, projects}` (since 2026-08-06); a
/// box that predates that answers with a bare `Project[]`. ONE type absorbs
/// both so the two call sites stay a single code path and neither has to know
/// which box it is talking to. Only `projects` is consumed — the caller finds
/// the created window by name — so the other two fields are deliberately
/// dropped rather than plumbed through to nothing.
struct TmuxCreateResult: Decodable, Equatable, Sendable {
    let projects: [MantaProject]

    private enum CodingKeys: String, CodingKey { case projects }

    init(from decoder: Decoder) throws {
        if let list = try? [MantaProject](from: decoder) {
            projects = list
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projects = try container.decode([MantaProject].self, forKey: .projects)
    }
}

/// Delete-input payload for `tmux:kill-window`.
struct KillWindowInput: Sendable {
    var sessionName: String
    var windowIndex: Int
}

// MARK: - Row presentation (§7.1 / §7.1a)

/// The live, store-derived status of a row. Values are inputs the store
/// resolves from the box (event stream + opencode session list); this enum
/// only decides how they are PRESENTED.
struct SessionRowStatus: Equatable, Sendable {
    var running: Bool
    var attention: Bool
    /// Number of non-terminal background jobs nested under this window
    /// (BET-1213). Missing delegation (an older box) is just 0 — a missing job
    /// list is missing decoration, never a missing session.
    var backgroundJobs: Int
    var modelLabel: String?
    /// BET-791: the model-authored progress label for a working turn (e.g.
    /// "Running integration tests"). Absent when the turn has no record, or
    /// when its state isn't `working`.
    var progressLabel: String? = nil
    /// Last known activity for the session (opencode `time.updated`), for the
    /// idle subtitle.
    var lastActivity: Date? = nil
    /// A tmux window with no opencode session — i.e. a terminal window.
    var isTerminal: Bool = false
}

/// Per-window live status for a TERMINAL window, as reported by the box's
/// tmux activity poller (`src/server/status.mjs`) on `kind: "status"` frames
/// (BET-1350). Chat-mode windows never populate this — their status comes
/// from the interpreted stream, and the pane scrape can't see them anyway
/// (a chat window's pane runs `sleep infinity`, so capture-pane is blank).
struct WindowPollStatus: Equatable, Sendable {
    var running: Bool
    var subagents: Int
}

enum SessionRowSubtitle {
    /// §7.1a subtitle table — precedence: background jobs, then the working
    /// progress label, then running, then blocked, then (idle) model. The
    /// background-job case REPLACES the line (the count is the number of
    /// non-terminal jobs nested under the window). A model-authored progress
    /// label (BET-791) is more informative than a bare "running" /
    /// "running · model", so it replaces both when a working turn names its
    /// step. The first four branches are unchanged from the original table;
    /// only the idle tail is new (BET-897): a terminal row says "terminal",
    /// otherwise the idle line is the model label alone; recency lives in the
    /// age chip (BET-1084).
    static func text(for s: SessionRowStatus) -> String? {
        if s.backgroundJobs > 0 {
            return "\(s.backgroundJobs) background job" + (s.backgroundJobs == 1 ? "" : "s")
        }
        if s.running {
            if let label = s.progressLabel, !label.isEmpty {
                return label
            }
            if let model = s.modelLabel, !model.isEmpty {
                return "running · \(model)"
            }
            return "running"
        }
        if s.attention {
            return "needs you"
        }
        if s.isTerminal { return "terminal" }
        // Recency lives in the trailing age chip (BET-1084); the subtitle is model-only.
        return s.modelLabel.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The subtitle with the project name as a leading caption — used by the
    /// flat Latest-activity ordering, where rows are no longer grouped under a
    /// project header ("better-ui · running · opus 4.8"). A row with nothing to
    /// say after the caption shows the caption alone, so the project is still
    /// readable.
    static func text(for s: SessionRowStatus, projectName: String?) -> String? {
        let base = text(for: s)
        guard let projectName, !projectName.isEmpty else { return base }
        guard let base, !base.isEmpty else { return projectName }
        return "\(projectName) · \(base)"
    }
}

/// The single definition of "recent" (BET-1349) — the age chip and the Recent
/// filter both read it, so they can never disagree. A row is RECENT when it is
/// mid-turn, or its last activity is inside the prompt-cache TTL.
enum SessionRecency {
    static func isRecent(_ s: SessionRowStatus, now: Date, ttlMs: Double) -> Bool {
        if s.running { return true }
        if s.attention { return true }
        guard let last = s.lastActivity else { return false }
        return now.timeIntervalSince(last) * 1000 < ttlMs
    }
}

/// The All / Recent filter row (BET-1349). Not persisted — resets to `.all` on
/// launch.
enum SessionFilter: String {
    case all
    case recent
}

/// Maps the box's `cacheTtl` config string to milliseconds, mirroring the
/// desktop `selectCacheTtlMs` (src/renderer/chatUtils.ts). Values are `"5m"`
/// and `"1h"`; anything else — or absent — means `"5m"`.
enum SessionCacheTtl {
    static let defaultMs: Double = 300_000
    static let oneHourMs: Double = 3_600_000

    static func ms(for configValue: String?) -> Double {
        switch configValue {
        case "1h": return oneHourMs
        default: return defaultMs // "5m", anything else, or absent
        }
    }
}

/// The row's trailing age slot (BET-1084): a pure gate mirroring the desktop
/// sidebar's `useAge` (src/renderer/Sidebar.tsx) — running / attention rows and
/// unknown-activity rows show no age; their dot is the signal. Past the
/// prompt-cache TTL the chip also disappears (BET-1349) — there is no hover on
/// a phone to hide a stale age behind.
enum SessionRowAge {
    static func text(for s: SessionRowStatus, now: Date, ttlMs: Double) -> String? {
        guard !s.running, !s.attention, let last = s.lastActivity else { return nil }
        let elapsedMs = now.timeIntervalSince(last) * 1000
        guard elapsedMs < ttlMs else { return nil }
        return SessionTimerFormat.age(now.timeIntervalSince(last))
    }
}

/// §7.1 status dot: running → accent, needs-you → warn, idle → tx4.
enum SessionDotState: Sendable {
    case running
    case needsYou
    case idle

    static func forRow(_ s: SessionRowStatus) -> SessionDotState {
        if s.attention { return .needsYou }
        if s.running { return .running }
        return .idle
    }
}

/// Where a row sits inside its project card, which decides its rounded corners
/// and whether it carries the hairline separator on its top edge (BET-897).
enum SessionCardPosition: Sendable, Equatable {
    case only, first, middle, last

    static func at(index: Int, count: Int) -> SessionCardPosition {
        if count <= 1 { return .only }
        if index == 0 { return .first }
        if index == count - 1 { return .last }
        return .middle
    }

    var roundsTop: Bool { self == .only || self == .first }
    var roundsBottom: Bool { self == .only || self == .last }
    /// Every row except a group's first carries the hairline.
    var showsSeparator: Bool { self == .middle || self == .last }
}

// MARK: - Timer / duration formatting (§7.1 timer slot, §7.3 confirm copy)

enum SessionTimerFormat {
    /// Friendly running-duration for the §7.3 running-delete confirm
    /// ("4 minutes", "36 seconds").
    static func runningDuration(_ interval: TimeInterval) -> String {
        let t = Int(interval.rounded())
        if t < 60 { return "\(t) second" + (t == 1 ? "" : "s") }
        let m = t / 60
        return "\(m) minute" + (m == 1 ? "" : "s")
    }

    /// Canonical compact timer format, mirrored 1:1 with the desktop
    /// `formatTimerDuration` (src/renderer/chatUtils.ts): "2h57m" / "57m" /
    /// "2h" / "45s". No spaces; seconds only under a minute; hours drop the
    /// minutes when they are zero. Use THIS for any elapsed/distance timer
    /// (running row, session list, usage idle text) — the single source of
    /// truth for the timer shape on iOS.
    static func compact(_ interval: TimeInterval) -> String {
        let t = Int(interval)
        guard t > 0 else { return "0s" }
        let s = t % 60
        let m = (t / 60) % 60
        let h = t / 3600
        if h > 0 { return m > 0 ? "\(h)h\(m)m" : "\(h)h" }
        if m > 0 { return "\(m)m" }
        return "\(s)s"
    }

    /// Seconds-precise elapsed for the in-chat working row, mirrored 1:1 with
    /// the desktop transcript's `formatDuration` (src/renderer/chatUtils.ts).
    /// Seconds survive past a minute, so a running turn ticks, not freezes on "1m".
    static func elapsed(_ interval: TimeInterval) -> String {
        guard interval.isFinite, interval >= 1 else { return "<1s" }
        let total = Int(interval.rounded())
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 { return "\(h)h\(m)m\(s)s" }
        if m > 0 { return "\(m)m\(s)s" }
        return "\(s)s"
    }

    /// Idle recency for a session row, mirrored 1:1 with the desktop sidebar's
    /// `formatAge` (src/renderer/chatUtils.ts): "now" / "N m" / "N h" / "N d".
    /// Negative and non-finite intervals clamp to "now".
    static func age(_ interval: TimeInterval) -> String {
        guard interval.isFinite, interval >= 60 else { return "now" }
        if interval < 3600 { return "\(Int(interval / 60))m" }
        if interval < 86400 { return "\(Int(interval / 3600))h" }
        return "\(Int(interval / 86400))d"
    }
}

// MARK: - Pin identity (client-side, persisted in config)

enum SessionPinID {
    /// `<tmuxSession>/<windowIndex>` — matches `windowPinId` on desktop.
    static func window(_ session: String, index: Int) -> String {
        "\(session)/\(index)"
    }
}

// MARK: - Pin ordering (BET-898)

enum SessionOrder {
    /// Pinned windows first, everything else in its existing tmux order.
    /// STABLE within each half — a pin must not otherwise reshuffle a project.
    /// Written as two filters rather than a comparator on purpose:
    /// `sort(by:)` in Swift is NOT guaranteed stable, and an unstable sort
    /// here would reorder unpinned windows on every pin toggle.
    static func sorted(_ windows: [MantaWindow], project: String, pinned: Set<String>) -> [MantaWindow] {
        let isPinned = { (w: MantaWindow) in pinned.contains(SessionPinID.window(project, index: w.index)) }
        return windows.filter(isPinned) + windows.filter { !isPinned($0) }
    }
}

// MARK: - Session list ordering (spec §3)

/// How the session list is ordered. Device-local, persisted through
/// `@AppStorage("sessionListOrder")` by its raw value.
enum SessionListOrdering: String, CaseIterable, Sendable {
    /// Grouped by project in tmux order; inside a project pinned windows first,
    /// then window index (≈ creation order). The long-standing behaviour.
    case created
    /// One flat list across projects, newest activity first. Pins are not
    /// lifted.
    case activity

    var label: String {
        switch self {
        case .created: return "Created"
        case .activity: return "Latest activity"
        }
    }

    var systemImage: String {
        switch self {
        case .created: return "folder"
        case .activity: return "clock"
        }
    }
}

/// One row of the flat Latest-activity list: a window plus the project it
/// lives in (a window index is only unique within its project).
struct SessionFlatEntry: Equatable, Sendable {
    let project: String
    let window: MantaWindow
}

enum SessionActivityOrder {
    /// The directories to ask opencode for sessions in — one per DISTINCT
    /// directory that holds a chat window, in first-seen order. A window's
    /// directory is its pane's cwd, falling back to its project's default cwd
    /// (desktop `backfillLastMessageTimes`). The unscoped session list is
    /// capped at 100 sessions, so anything older never got a last activity;
    /// listing per directory is what covers every window.
    static func chatDirectories(_ projects: [MantaProject]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for project in projects {
            for window in project.windows where window.hasChatSession {
                let dir = window.paneCurrentPath.isEmpty ? project.defaultCwd : window.paneCurrentPath
                if !dir.isEmpty, seen.insert(dir).inserted { out.append(dir) }
            }
        }
        return out
    }

    /// The later of two optional instants — how a window's last activity is
    /// composed from the box's `time.updated` and the live running/idle
    /// transitions the event stream reported since.
    static func latest(_ a: Date?, _ b: Date?) -> Date? {
        switch (a, b) {
        case let (a?, b?): return max(a, b)
        case let (a?, nil): return a
        case let (nil, b?): return b
        case (nil, nil): return nil
        }
    }

    /// Flatten `projects` into one list, newest activity first.
    ///
    /// Three tiers, in this order:
    /// 1. chat windows with a known last activity, newest first;
    /// 2. chat windows whose activity is unknown (not fetched yet);
    /// 3. terminal windows, which have no opencode session and so no activity
    ///    at all — by window index.
    /// Ties break on project order, then window index. Pins are deliberately
    /// ignored: this ordering answers "what did I touch last", and a pinned
    /// window you haven't touched in a week would otherwise sit on top of it.
    ///
    /// Every comparator below is a TOTAL order — `(project order, window
    /// index)` is unique per window — so the result is deterministic and an
    /// unstable `sort` cannot make rows jump between refreshes.
    static func flatten(
        _ projects: [MantaProject],
        lastActivity: (_ project: String, _ window: MantaWindow) -> Date?
    ) -> [SessionFlatEntry] {
        struct Item {
            let entry: SessionFlatEntry
            let projectOrder: Int
            let date: Date?
        }
        var dated: [Item] = []
        var undated: [Item] = []
        var terminals: [Item] = []
        for (projectOrder, project) in projects.enumerated() {
            for window in project.windows {
                let entry = SessionFlatEntry(project: project.tmuxSession, window: window)
                if !window.hasChatSession {
                    terminals.append(Item(entry: entry, projectOrder: projectOrder, date: nil))
                } else if let date = lastActivity(project.tmuxSession, window) {
                    dated.append(Item(entry: entry, projectOrder: projectOrder, date: date))
                } else {
                    undated.append(Item(entry: entry, projectOrder: projectOrder, date: nil))
                }
            }
        }
        dated.sort { l, r in
            if let ld = l.date, let rd = r.date, ld != rd { return ld > rd }
            if l.projectOrder != r.projectOrder { return l.projectOrder < r.projectOrder }
            return l.entry.window.index < r.entry.window.index
        }
        undated.sort { l, r in
            if l.projectOrder != r.projectOrder { return l.projectOrder < r.projectOrder }
            return l.entry.window.index < r.entry.window.index
        }
        terminals.sort { l, r in
            if l.entry.window.index != r.entry.window.index { return l.entry.window.index < r.entry.window.index }
            return l.projectOrder < r.projectOrder
        }
        return (dated + undated + terminals).map(\.entry)
    }
}

// MARK: - Background job presentation (spec §4)

enum BackgroundJobFormat {
    /// The status word shown beside the dot. A status a newer box invented is
    /// shown as the box wrote it rather than hidden.
    static func statusLabel(_ job: DelegateJob) -> String {
        switch job.status {
        case "running", "paused", "done", "failed", "stopped": return job.status
        default: return job.status.isEmpty ? "unknown" : job.status
        }
    }

    /// Elapsed time for a live job, the finish time for a finished one.
    ///
    /// Running/paused: "4m" since it started. Finished: "finished 12m ago", or
    /// "finished just now" inside the first minute. Nil when the box gave no
    /// timestamp to count from — nothing is fabricated from the device clock.
    static func timing(_ job: DelegateJob, now: Date) -> String? {
        func date(_ ms: Double?) -> Date? {
            guard let ms, ms > 0 else { return nil }
            return Date(timeIntervalSince1970: ms / 1000)
        }
        if job.isActive {
            guard let start = date(job.startedAt) ?? date(job.createdAt) else { return nil }
            return SessionTimerFormat.compact(max(0, now.timeIntervalSince(start)))
        }
        guard let end = date(job.finishedAt) else { return nil }
        let age = SessionTimerFormat.age(max(0, now.timeIntervalSince(end)))
        return age == "now" ? "finished just now" : "finished \(age) ago"
    }

    /// Why a job operation failed, in words a person can act on. Only a message
    /// the box wrote for a human is passed through; anything else (a decoding
    /// failure, a URLError) is reduced to the one thing the user can do.
    static func failureReason(_ error: Error) -> String {
        switch error {
        case MantaError.authRequired:
            return "this device isn't signed in to the box"
        case MantaError.server(let text) where !text.isEmpty:
            return text
        case MantaError.transport(let text) where !text.isEmpty:
            return text
        default:
            return "check the connection"
        }
    }

    /// Newest first: live jobs above finished ones, then by when they began.
    static func sorted(_ jobs: [DelegateJob]) -> [DelegateJob] {
        func began(_ j: DelegateJob) -> Double { j.startedAt ?? j.createdAt ?? 0 }
        return jobs.sorted { l, r in
            if l.isActive != r.isActive { return l.isActive }
            let lb = began(l), rb = began(r)
            if lb != rb { return lb > rb }
            return l.id < r.id
        }
    }
}

// MARK: - Model label (§7.1 subtitle "running · opus 4.8")

enum ModelLabel {
    /// A compact, data-faithful model label for the running subtitle. Known
    /// Anthropic ids collapse to their friendly family ("claude-opus-4-7" →
    /// "opus 4.7"); anything unknown falls back to the raw modelID (honest —
    /// never invents a name). Device-side formatting, per §17.
    static func text(providerID: String?, modelID: String) -> String {
        if let providerID, providerID.lowercased() == "anthropic" {
            var id = modelID
            for prefix in ["anthropic/", "claude-"] where id.hasPrefix(prefix) {
                id = String(id.dropFirst(prefix.count))
            }
            // "opus-4-7" → "opus 4.7": the family word then dotted numbers.
            let m = id.split(separator: "-")
            if m.count >= 2, let family = m.first,
               m.dropFirst().allSatisfy({ Int($0) != nil }) {
                let numbers = m.dropFirst().joined(separator: ".")
                return "\(family) \(numbers)"
            }
            return id.replacingOccurrences(of: "-", with: " ")
        }
        return modelID.replacingOccurrences(of: "-", with: " ")
    }
}

// MARK: - Delete semantics (§7.3)

/// A delete that is held pending its 5-second undo window. The RPC is not
/// fired until the window expires; an undo cancels it.
struct PendingDelete: Equatable, Sendable {
    enum Target: Equatable, Sendable {
        case window(session: String, index: Int)
    }

    var target: Target
    var pinID: String
    /// When the 5s undo window started; `expired(now:)` decides the commit.
    var startedAt: Date

    /// The §7.3 undo window length.
    static let undoWindow: TimeInterval = 5

    func expired(now: Date) -> Bool {
        now.timeIntervalSince(startedAt) >= Self.undoWindow
    }
}

// MARK: - Folder browsing helpers (ported from src/renderer/folderPicker.ts)

enum FolderPath {
    static func isDimmed(_ name: String) -> Bool {
        if name == "node_modules" { return true }
        return name.hasPrefix(".")
    }

    static func crumbLabel(_ path: String) -> String {
        if path == "~" { return "~" }
        if path == "/" { return "/" }
        guard let idx = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: idx)...])
    }

    static func parentPath(_ path: String) -> String {
        let raw = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return "" }
        if raw == "~" || raw == "/" { return raw }
        let slash = String(raw)
        if slash.hasPrefix("~/") {
            guard let idx = slash.lastIndex(of: "/"), idx != slash.startIndex else { return "~" }
            if slash.distance(from: slash.startIndex, to: idx) <= 1 { return "~" }
            return String(slash[..<idx])
        }
        if slash.hasPrefix("/") {
            guard let idx = slash.lastIndex(of: "/") else { return slash }
            if idx == slash.startIndex { return "/" }
            return String(slash[..<idx])
        }
        return raw
    }

    /// `~/code/foo` → ["~", "~/code", "~/code/foo"]; absolute likewise.
    static func breadcrumbs(_ path: String) -> [String] {
        let raw = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return [] }
        if raw == "~" { return ["~"] }
        if raw.hasPrefix("~/") {
            let parts = raw.dropFirst(2).split(separator: "/").map(String.init)
            var out: [String] = ["~"]
            var acc = "~"
            for p in parts {
                acc += "/" + p
                out.append(acc)
            }
            return out
        }
        if raw.hasPrefix("/") {
            let parts = raw.split(separator: "/").map(String.init)
            var out: [String] = ["/"]
            var acc = ""
            for p in parts {
                acc += "/" + p
                out.append(acc)
            }
            return out
        }
        return [raw]
    }
}

// MARK: - Worktree helpers (ported from folderPicker.ts)

enum WorktreeInfoLogic {
    /// `⎇ N worktrees` when N > 1, else "" (a single main checkout is noise).
    static func badge(_ worktrees: [MantaWorktree]?) -> String {
        guard let worktrees, worktrees.count > 1 else { return "" }
        return "⎇ \(worktrees.count) worktrees"
    }

    static func hasFanOut(_ worktrees: [MantaWorktree]?) -> Bool {
        guard let worktrees else { return false }
        return worktrees.count > 1
    }

    /// `⎇ main` when inside a repo (gitListWorktrees returns the main
    /// checkout first), else "".
    static func gitStateLabel(_ worktrees: [MantaWorktree]?) -> String {
        guard let worktrees, let main = worktrees.first, let branch = main.branch, !branch.isEmpty else {
            return ""
        }
        return "⎇ \(branch)"
    }

    /// Window name for a worktree: dir basename (matches desktop).
    static func name(_ w: MantaWorktree) -> String {
        let parts = w.path.split(separator: "/").filter { !$0.isEmpty }
        if let last = parts.last { return String(last) }
        return w.branch ?? "wt"
    }
}

// MARK: - Haptics (§7.4) — user-disableable

/// The §7.4 haptic vocabulary, classified as a pure enum so the store can
/// record/gate it. The view maps each case to a UIKit `UIImpactFeedbackGenerator`
/// / `UINotificationFeedbackGenerator` firing, respecting the enable flag.
enum SessionHapticKind: Sendable, Equatable {
    case impactLight   // swipe passes the commit threshold
    case selection     // a value crosses a discrete step
    case warning       // destructive confirm for a running session
    case success       // a delete finally lands
}

/// Pure decision for the BET-673 turn-complete success haptic. The chat fires
/// ONE success haptic only when a turn just completed (the false→true edge of
/// `turnComplete`) while the user has scrolled up (the scroll-to-bottom chip is
/// showing) and the scene is foreground/active, and only while haptics are
/// enabled. Mirrors the §7.4 attention model: no edge, chip, scene or setting
/// → no haptic. No haptic when at the bottom (completion is visible) and no
/// haptic from `running` oscillations — only the genuine completion edge.
func shouldFireTurnCompleteHaptic(
    turnCompleteEdge: Bool,
    showScrollToBottom: Bool,
    isActive: Bool,
    hapticsEnabled: Bool
) -> Bool {
    turnCompleteEdge && showScrollToBottom && isActive && hapticsEnabled
}

/// User-facing text for a failed create. The box sends a specific, actionable
/// reason (a missing directory, a name clash); the sheet used to replace all of
/// it with one generic line, which is why a create failure was undiagnosable
/// from the phone. Anything that is NOT a message written for a human — a
/// decoding failure, a URLError — still falls back to the generic line, because
/// its text would mean nothing to the user.
enum SessionCreateFailure {
    static let generic = "Couldn't create the session."

    static func message(for error: Error) -> String {
        switch error {
        case MantaError.authRequired:
            return "Not signed in to this box."
        case MantaError.server(let text) where !text.isEmpty:
            return text
        case MantaError.transport(let text) where !text.isEmpty:
            return text
        default:
            return generic
        }
    }
}

// ===========================================================================
// Quote selection → composer (BET-1353).
//
// Pure Swift ports of the desktop `truncateMiddle` / `buildQuoteBlock`
// (src/renderer/chatUtils.ts, BET-1351), with a narrower phone-composer
// budget. A selection is normalised into ONE middle-truncated blockquote line
// (`"> …\n\n"`) that gets PREPENDED to whatever is already in the composer.
// There is deliberately no hidden payload / chip / extra composer state: the
// model already holds the full transcript in its context, so the quote only
// has to be a locatable pointer. Collapsing to a single line also kills the
// class of bug where a selection spanning several rendered blocks serialises
// without its newlines.
// ===========================================================================

/// Where a quote should land (BET-1353).
enum QuoteDestination {
    /// Quote into THIS session's composer.
    case thisSession
    /// Fork this session, seed the fork's composer, and open the fork.
    case newSession
}

/// Pure quote-building helpers, ported 1:1 from `chatUtils.ts` (BET-1351) with
/// the phone-composer budget (`max`/`head`/`tail`).
enum QuoteText {
    /// Longest quoted line, in characters.
    static let max = 160
    /// Characters kept from the head of a quote that exceeds `max`.
    static let head = 95
    /// Characters kept from the tail of a quote that exceeds `max`.
    static let tail = 55

    /// "beginning … end". Returns `text` unchanged when it fits within `max`.
    /// Counts CHARACTERS (grapheme clusters), never UTF-16 code units, so an
    /// emoji or accented character is never split. The ellipsis is ONE U+2026
    /// with a single space either side.
    static func truncateMiddle(_ text: String, max: Int, head: Int, tail: Int) -> String {
        let chars = Array(text)
        if chars.count <= max { return text }
        let headPart = String(chars[0..<head]).trimmingCharacters(in: .whitespacesAndNewlines)
        let tailPart = String(chars[(chars.count - tail)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return headPart + " \u{2026} " + tailPart
    }

    /// Selection → the exact string to prepend to the composer, or nil when the
    /// selection has no usable text. Whitespace runs collapse to a single
    /// space, the result is trimmed, truncated, then prefixed with `"> "` and
    /// suffixed with a blank line (`"\n\n"`).
    static func buildQuoteBlock(_ selection: String) -> String? {
        let collapsed = selection
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty else { return nil }
        let truncated = truncateMiddle(collapsed, max: max, head: head, tail: tail)
        return "> " + truncated + "\n\n"
    }
}
