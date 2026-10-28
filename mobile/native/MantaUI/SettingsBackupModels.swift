import Foundation

// ===========================================================================
// WS10 F7 — Restore windows (Backup). Pure decisions behind the screen:
// what the preview state is, which strings the desktop shows for it, and when
// Restore may be offered. Foundation-only ([pkg], D19).
//
// A FAILED preview is a different state from "No backup yet": the desktop
// swallows a failure into null, which renders no status at all. iOS does not
// copy that silence — it says the layout could not be loaded and offers a retry,
// and it never offers Restore without a successful preview.
// ===========================================================================

enum BackupPreviewState: Equatable, Sendable {
    case loading
    case loaded(TopologyRestorePreview)
    case failed(String)
}

enum BackupSummary {

    static let intro =
        "Manta saves your chat window layout — names, order and grouping — so it can be rebuilt if the box's terminal server restarts. Your conversations are stored separately and are never affected."
    static let noBackupLine =
        "No backup yet. Manta saves your window layout automatically as you work."
    static let nothingToRestoreLine = "Every saved window is already open."

    /// Saved windows the snapshot describes: planned + skipped.
    static func windows(_ preview: TopologyRestorePreview) -> Int {
        preview.ops.count + preview.skipped.count
    }

    /// Distinct tmux sessions (projects) among them.
    static func projects(_ preview: TopologyRestorePreview) -> Int {
        Set((preview.ops.map(\.tmuxSession)) + (preview.skipped.map(\.tmuxSession))).count
    }

    /// "Last backup <date> · W windows across P projects" — nil when the box
    /// reported no capture time. `formatDate` takes epoch milliseconds so the
    /// pure side never touches a locale.
    static func lastBackupLine(_ preview: TopologyRestorePreview, formatDate: (Double) -> String) -> String? {
        guard let capturedAt = preview.capturedAt else { return nil }
        return "Last backup \(formatDate(capturedAt)) · \(windows(preview)) windows across \(projects(preview)) projects"
    }

    /// "N window(s) can be restored." / "Every saved window is already open."
    static func restorableLine(_ preview: TopologyRestorePreview) -> String {
        preview.restorable > 0
            ? "\(preview.restorable) window(s) can be restored."
            : nothingToRestoreLine
    }

    /// The whole status block for a loaded preview, one line per fact.
    static func statusLine(_ preview: TopologyRestorePreview, formatDate: (Double) -> String) -> String {
        guard preview.available else { return noBackupLine }
        return [lastBackupLine(preview, formatDate: formatDate), restorableLine(preview)]
            .compactMap { $0 }
            .joined(separator: "\n")
    }

    /// Restore is offered only after a successful preview that found a backup.
    static func showsRestore(_ state: BackupPreviewState) -> Bool {
        if case .loaded(let preview) = state { return preview.available }
        return false
    }

    /// …and is enabled only when something is actually restorable.
    static func restoreEnabled(_ state: BackupPreviewState) -> Bool {
        if case .loaded(let preview) = state { return preview.available && preview.restorable > 0 }
        return false
    }

    /// The outcome line after a restore: the box's own message (desktop parity),
    /// or the failure with its reason.
    static func restoreOutcome(_ result: TopologyRestoreResult) -> (ok: Bool, text: String) {
        if result.ok {
            let message = result.message ?? ""
            return (true, message.isEmpty ? "Windows restored." : message)
        }
        return (false, "Couldn't restore your windows. \(result.error ?? "unknown error")")
    }
}
