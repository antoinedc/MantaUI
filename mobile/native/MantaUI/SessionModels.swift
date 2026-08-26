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

    var id: Int { index }
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
struct DelegateJob: Codable, Equatable, Sendable {
    var id: String
    var parentSessionID: String?
    var childSessionID: String?
    var status: String

    /// Whether the job is still live. `done`/`failed`/`stopped` are terminal;
    /// anything else (a running job, or a status a newer box added) counts as
    /// active so the count never under-reports a live job.
    var isActive: Bool {
        status != "done" && status != "failed" && status != "stopped"
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
