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
    var subagentsRunning: Int
    var modelLabel: String?
}

enum SessionRowSubtitle {
    /// §7.1a subtitle table — precedence: subagents, then running, then
    /// blocked, then (nil) idle. The subagent case REPLACES the line.
    static func text(for s: SessionRowStatus) -> String? {
        if s.subagentsRunning > 0 {
            return "\(s.subagentsRunning) subagent" + (s.subagentsRunning == 1 ? "" : "s")
        }
        if s.running {
            if let model = s.modelLabel, !model.isEmpty {
                return "running · \(model)"
            }
            return "running"
        }
        if s.attention {
            return "needs you"
        }
        return nil
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

// MARK: - Timer / duration formatting (§7.1 timer slot, §7.3 confirm copy)

enum SessionTimerFormat {
    /// Compact elapsed line for the row's timer slot (11px mono, tabular).
    static func elapsed(_ interval: TimeInterval) -> String {
        let t = Int(interval)
        if t < 60 { return "\(t)s" }
        let m = t / 60
        if m < 60 { return "\(m)m" }
        return "\(m / 60)h"
    }

    /// Friendly running-duration for the §7.3 running-delete confirm
    /// ("4 minutes", "36 seconds").
    static func runningDuration(_ interval: TimeInterval) -> String {
        let t = Int(interval.rounded())
        if t < 60 { return "\(t) second" + (t == 1 ? "" : "s") }
        let m = t / 60
        return "\(m) minute" + (m == 1 ? "" : "s")
    }
}

// MARK: - Pin identity (client-side, persisted in config)

enum SessionPinID {
    /// `<tmuxSession>/<windowIndex>` — matches `windowPinId` on desktop.
    static func window(_ session: String, index: Int) -> String {
        "\(session)/\(index)"
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
