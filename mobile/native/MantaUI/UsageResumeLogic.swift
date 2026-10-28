import Foundation

// ===========================================================================
// WS09 F6 — view-state arithmetic for the resume screen. The rows, header,
// chips, cost labels and the arm/disarm plan are the box's
// (`usage-stopped:view` / `usage-stopped:apply`); what stays here is the footer
// sum over the box's numbers and the checkbox-selection rule while the box's
// list changes under an open sheet (same rule as the desktop modal's
// `reconcileResumeSelection`).
// ===========================================================================

enum UsageResumeFooter {
    /// "2 selected · ≈ 340k re-read" or "1 selected · no extra cost".
    static func text(selectedRows: [UsageResumeRowWire]) -> String {
        let total = selectedRows.reduce(0.0) { $0 + $1.cost.reReadTokens }
        let head = "\(selectedRows.count) selected"
        return total > 0 ? "\(head) · ≈ \(UsageMeters.formatTokens(total)) re-read" : "\(head) · no extra cost"
    }

    /// How many selected rows reset past the prompt-cache window (drives the cold note).
    static func coldCount(selectedRows: [UsageResumeRowWire]) -> Int {
        selectedRows.filter { !$0.cost.warm }.count
    }

    /// The box's cold-note template, with `{n}` filled for the plural form.
    static func coldNote(_ note: UsageResumeViewWire.ColdNote, count: Int) -> String? {
        if count <= 0 { return nil }
        return count == 1 ? note.one : note.many.replacingOccurrences(of: "{n}", with: String(count))
    }
}

enum UsageResumeSelection {
    /// While the user has not touched anything (`pristine`) the selection tracks
    /// the armed rows; afterwards it is `selected ∩ viewIDs` — vanished rows leave,
    /// the user's other choices stay, new rows are not auto-selected.
    static func reconcile(selected: Set<String>, pristine: Bool, viewIDs: Set<String>, armedIDs: Set<String>) -> Set<String> {
        pristine ? armedIDs : selected.intersection(viewIDs)
    }
}
