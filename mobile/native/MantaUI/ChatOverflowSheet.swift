import SwiftUI

// ===========================================================================
// §8 chat overflow sheet (BET-626 shell; items land in BET-627/628/629).
//
// The chat header is specced as exactly TWO controls — back and overflow
// (DECISIONS.md:619) — because three 36px targets 2px apart failed every
// touch-target guideline, and the answer was fewer controls rather than bigger
// ones (DECISIONS.md:770-775). Everything else lives here.
//
// The sheet header carries the session name and its git branch (decision D4).
// The branch deliberately does NOT go in the chat screen's two-line header:
// that header is a status line with three fields already, and a branch is
// reference information you look up, not status you monitor.
//
// Rows are stock `Button`s in a `List`, so the system supplies the row height,
// the separator inset, the pressed state and VoiceOver. Destructive rows use
// `.destructive` roles, and a confirmation is a NATIVE action sheet — never a
// web dialog, which stamps the box hostname on itself (DECISIONS.md:709-715).
// ===========================================================================

/// The compact confirm gate (BET-747 task 1): a blind tap on the overflow
/// "Compact session" row must NOT reach the store — it only arms the confirm
/// sheet. A compact proceeds solely from the confirm-sheet's destructive action.
/// Extracted at file scope so the gate's before/after decision is unit-testable
/// without rendering the SwiftUI hierarchy.
enum CompactConfirmGate {
    /// Whether a compact action is allowed to proceed. `confirmed` is `true`
    /// only after the user taps the confirm sheet's destructive "Compact
    /// session" button; a plain row tap (`false`) withholds the store call.
    static func shouldProceed(confirmed: Bool) -> Bool { confirmed }
}

struct ChatOverflowSheet: View {
    let sessionTitle: String
    let projectName: String

    var onSchedules: () -> Void
    var onSecrets: () -> Void
    var onCompact: () -> Void
    var onClear: () -> Void
    var onFork: () -> Void
    var onOpenTerminal: () -> Void
    var onDelete: () -> Void

    /// Live count for the scheduled-tasks row (§8: "with live count").
    var scheduleCount: Int = 0

    /// Clear/Delete/Compact confirmations. Presented as a compact native
    /// bottom sheet (`ConfirmActionSheet`) from within this sheet, so it layers
    /// over the overflow sheet (sheet-on-sheet). No system primitive renders a
    /// detached Cancel on iOS 26 — see `ConfirmActionSheet` (DECISIONS.md:709-715).
    ///
    /// Compact is confirm-gated too (BET-747): compacting summarizes/drops the
    /// transcript's context, so a blind tap must not destroy it without consent
    /// — the same reason Clear and Delete confirm.
    @State private var confirmingClear = false
    @State private var confirmingDelete = false
    @State private var confirmingCompact = false

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row("Scheduled tasks", systemImage: "clock", badge: scheduleCount, action: onSchedules)
                    row("Secrets", systemImage: "key", action: onSecrets)
                }
                Section {
                    Button {
                        onCompactTap()
                    } label: {
                        Label("Compact session", systemImage: "arrow.down.right.and.arrow.up.left")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    row("Fork session", systemImage: "arrow.triangle.branch", action: onFork)
                    row("Open terminal", systemImage: "terminal", action: onOpenTerminal)
                }
                Section {
                    // Clear is the consequence of something the user just chose,
                    // so it confirms in an action sheet, not an alert — with the
                    // destructive item at the top (DECISIONS.md:709-715).
                    Button("Clear session", role: .destructive) { confirmingClear = true }
                    Button("Delete session", role: .destructive) { confirmingDelete = true }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(sessionTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { titleBlock }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // Clear/Delete confirm in a native action sheet — never a web dialog
        // (DECISIONS.md:709-715). No system primitive on iOS 26 renders a
        // detached Cancel, so these present a compact SwiftUI bottom sheet
        // (`ConfirmActionSheet`) from within this sheet: destructive item first,
        // Cancel separated at the bottom.
        .confirmActionSheet(
            isPresented: $confirmingClear,
            title: "Clear this session?",
            message: "Starts a fresh session in this window. The transcript stays on the box.",
            destructiveTitle: "Clear session",
            destructiveAction: { dismiss(); onClear() }
        )
        .confirmActionSheet(
            isPresented: $confirmingDelete,
            title: "Delete this session?",
            message: "Removes the session and its window. This cannot be undone.",
            destructiveTitle: "Delete session",
            destructiveAction: { dismiss(); onDelete() }
        )
        .confirmActionSheet(
            isPresented: $confirmingCompact,
            title: "Compact this session?",
            message: "Summarises the conversation to free context. The transcript is condensed, not deleted.",
            destructiveTitle: "Compact session",
            destructiveAction: { dismiss(); onCompact() }
        )
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    /// Session name over the project name — the reference block (D4). The git
    /// branch lives in the chat's own branch capsule (BET-747), not here, so it
    /// is not duplicated across the two surfaces.
    private var titleBlock: some View {
        VStack(spacing: 1) {
            Text(sessionTitle)
                .font(.headline)
                .lineLimit(1)
            Text(projectName)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private func row(
        _ title: String,
        systemImage: String,
        badge: Int = 0,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            dismiss()
            action()
        } label: {
            HStack {
                Label(title, systemImage: systemImage)
                Spacer(minLength: 8)
                if badge > 0 {
                    Text("\(badge)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    /// A tap on the "Compact session" row. Conceived as a destructive control
    /// (compacting summarizes/drops the transcript's context), it must not fire
    /// the store on a blind tap — `CompactConfirmGate.shouldProceed(confirmed: false)`
    /// withholds it and arms the confirm sheet instead; the store runs only from
    /// the confirm sheet's destructive action.
    private func onCompactTap() {
        if CompactConfirmGate.shouldProceed(confirmed: false) {
            onCompact()
        } else {
            confirmingCompact = true
        }
    }
}
