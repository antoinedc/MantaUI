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

/// Which of the second section's mode controls the overflow shows. The mode rows
/// (Chat / Terminal / AI CLI) are mounted only when the caller supplies ALL of
/// `mode`, `onSelectMode` and `onRetryLaunchers` — so a failed launcher catalog's
/// "Try again" row can never be a dead button — and never in a read-only
/// background-job chat. Otherwise the legacy "Open terminal" row stays (capture scene,
/// older callers); a read-only job shows neither.
enum OverflowModeRowsGate {
    static func mount(hasMode: Bool, hasSelect: Bool, hasRetry: Bool, readOnly: Bool) -> Bool {
        !readOnly && hasMode && hasSelect && hasRetry
    }

    static func showsOpenTerminal(hasMode: Bool, hasSelect: Bool, hasRetry: Bool, readOnly: Bool) -> Bool {
        !readOnly && !mount(hasMode: hasMode, hasSelect: hasSelect, hasRetry: hasRetry, readOnly: readOnly)
    }
}

struct ChatOverflowSheet: View {
    let sessionTitle: String
    let projectName: String

    var onSchedules: () -> Void
    var onSecrets: () -> Void
    var onArtifacts: () -> Void
    /// Opens the Background jobs sheet. Required (no default) on purpose: the
    /// entry below is shown whenever `backgroundJobs.total > 0`, and a default
    /// no-op here would let a caller ship a row that does nothing when tapped.
    var onBackgroundJobs: () -> Void
    var onCompact: () -> Void
    var onClear: () -> Void
    var onFork: () -> Void
    var onOpenTerminal: () -> Void
    var onDelete: () -> Void

    /// Observed so the trust toggle below reflects the live `chatAutoAllow`
    /// value (and reverts on a failed update) without the sheet holding its
    /// own copy of the setting.
    @ObservedObject var settingsStore: MantaSettingsStore
    /// Flip the `chatAutoAllow` setting. Called with the requested value; the
    /// chat screen awaits the `config:update` and reverts on failure.
    var onToggleTrust: (Bool) -> Void

    /// Live count for the scheduled-tasks row (§8: "with live count").
    var scheduleCount: Int = 0

    /// Background jobs this session has started: `total` is every job on record
    /// (the row is hidden at 0 — a session that never had one has nothing to
    /// show), `running` the live ones, shown as the row's count.
    var backgroundJobs: (total: Int, running: Int) = (total: 0, running: 0)

    /// Auto-handoff (spec §9): the three-way mode control under "Trust mode" and
    /// the "Previous sessions" list. nil hides both — a control with nothing to
    /// drive is not drawn (the capture scene has no chat to hand off).
    var handoff: HandoffStore? = nil
    /// Open a previous session read-only. Required for the list to be shown: a
    /// row that could not open anything must not exist.
    var onOpenPrevious: ((HandoffPreviousEntry) -> Void)? = nil

    // MARK: Received mounts (WS07). Declared LAST: argument order at a call site is
    // declaration order, so a caller appends these after `onOpenPrevious:` in the order below.
    /// A read-only background-job chat (M-02-2): Compact, Clear, Fork, Delete, the Trust
    /// toggle, Rename and the mode rows are hidden. Scheduled / Secrets / Artifacts /
    /// Webhooks / Background jobs and the display toggle stay.
    var isReadOnlyJob: Bool = false
    /// "Rename session" (M-04-1) — hidden when nil.
    var onRename: (() -> Void)? = nil
    /// The Mode rows (M-04-2): current mode, the installed-CLI list and its catalog
    /// state, and the two closures. Mounted only when `mode`, `onSelectMode` and
    /// `onRetryLaunchers` are all present.
    var mode: SessionMode? = nil
    var launchers: [AvailableLauncher] = []
    var launcherCatalog: SessionLauncherCatalog = .loading
    var onSelectMode: ((SessionMode) -> Void)? = nil
    var onRetryLaunchers: (() -> Void)? = nil
    /// Opens the Webhooks card — the row is hidden when nil (a control with nothing to
    /// drive is not drawn).
    var onWebhooks: (() -> Void)? = nil

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

    /// "Show reasoning & full output" (M-01-5) — the app-wide transcript detail switch.
    /// Read through AppStorage so the row follows the live value; written ONLY through
    /// `TranscriptDisplayOptions.setShowDetails` so an open transcript refetches.
    @AppStorage(TranscriptDisplayOptions.defaultsKey) private var showDetails = false

    @Environment(\.dismiss) private var dismiss

    private var modeRowsMounted: Bool {
        OverflowModeRowsGate.mount(hasMode: mode != nil, hasSelect: onSelectMode != nil,
                                   hasRetry: onRetryLaunchers != nil, readOnly: isReadOnlyJob)
    }

    private var showsOpenTerminal: Bool {
        OverflowModeRowsGate.showsOpenTerminal(hasMode: mode != nil, hasSelect: onSelectMode != nil,
                                               hasRetry: onRetryLaunchers != nil, readOnly: isReadOnlyJob)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row("Scheduled tasks", systemImage: "clock", badge: scheduleCount, action: onSchedules)
                    row("Secrets", systemImage: "key", action: onSecrets)
                    if let onWebhooks {
                        row("Webhooks", systemImage: "point.3.connected.trianglepath.dotted", action: onWebhooks)
                    }
                    row("Artifacts", systemImage: "doc", action: onArtifacts)
                    if backgroundJobs.total > 0 {
                        row("Background jobs", systemImage: "square.stack.3d.up",
                            badge: backgroundJobs.running, action: onBackgroundJobs)
                    }
                }
                if !isReadOnlyJob {
                    Section {
                        if let onRename {
                            row("Rename session", systemImage: "pencil", action: onRename)
                        }
                        Button {
                            onCompactTap()
                        } label: {
                            Label("Compact session", systemImage: "arrow.down.right.and.arrow.up.left")
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        row("Fork session", systemImage: "arrow.triangle.branch", action: onFork)
                        if showsOpenTerminal {
                            row("Open terminal", systemImage: "terminal", action: onOpenTerminal)
                        }
                    }
                }
                // `SessionModeRows` emits its own top-level Sections ("Mode", and "AI CLI"
                // when there is something to show), so it is a SIBLING of the sections
                // around it — nested in a `Section {}` it would lose its header and
                // grouping. Its rows do not dismiss themselves, hence the wrapper.
                if modeRowsMounted, let mode, let onSelectMode, let onRetryLaunchers {
                    SessionModeRows(
                        current: mode,
                        launchers: launchers,
                        catalog: launcherCatalog,
                        onSelect: { selected in
                            dismiss()
                            onSelectMode(selected)
                        },
                        onRetry: onRetryLaunchers
                    )
                }
                // Trust mode — the on/off autonomy switch (BET-748 gap #14). This
                // is the ONLY trust control in chat (no permission allow-lists);
                // it flips the `chatAutoAllow` config key over `config:update`.
                Section {
                    if !isReadOnlyJob, let entry = SettingsSchema.entries.first(where: { $0.id == "chatAutoAllow" }) {
                        Toggle(isOn: Binding(
                            get: { settingsStore.current(entry) == .bool(true) },
                            set: { onToggleTrust($0) }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Trust mode")
                                Text("Auto-allow tool permissions")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityIdentifier("trust-mode-toggle")
                    }
                    Toggle(isOn: Binding(
                        get: { showDetails },
                        set: { TranscriptDisplayOptions.setShowDetails($0) }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Show reasoning & full output")
                            Text("Thinking steps and complete tool output")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("show-details-toggle")
                    // Handoff mode — auto / suggest / off, directly under Trust mode.
                    if let handoff {
                        HandoffModeRow(store: handoff)
                    }
                }
                if let handoff, let onOpenPrevious {
                    HandoffPreviousSection(store: handoff) { entry in
                        dismiss()
                        onOpenPrevious(entry)
                    }
                }
                if !isReadOnlyJob {
                    Section {
                        // Clear is the consequence of something the user just chose,
                        // so it confirms in an action sheet, not an alert — with the
                        // destructive item at the top (DECISIONS.md:709-715).
                        Button("Clear session", role: .destructive) { confirmingClear = true }
                        Button("Delete session", role: .destructive) { confirmingDelete = true }
                    }
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
            copy: SessionConfirmCopy.clear,
            destructiveAction: { dismiss(); onClear() }
        )
        .confirmActionSheet(
            isPresented: $confirmingDelete,
            copy: SessionConfirmCopy.delete,
            destructiveAction: { dismiss(); onDelete() }
        )
        .confirmActionSheet(
            isPresented: $confirmingCompact,
            copy: SessionConfirmCopy.compact,
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
