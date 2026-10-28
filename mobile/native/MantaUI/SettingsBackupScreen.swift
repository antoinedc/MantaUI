import SwiftUI

// ===========================================================================
// WS10 F7 — Restore windows. Rebuilds the chat window layout (names, order,
// grouping) from the box's last saved snapshot if its terminal server restarted.
// Conversations are stored separately and are never affected.
//
// States are the pure `BackupPreviewState`. A FAILED preview says so and offers
// "Try again" — Restore is never offered without a successful preview (the
// desktop swallows the failure into "no status at all"; this does not).
// ===========================================================================

@MainActor
final class SettingsBackupModel: ObservableObject {

    struct Dependencies: Sendable {
        var preview: @Sendable () async throws -> TopologyRestorePreview
        var restore: @Sendable () async throws -> TopologyRestoreResult

        static func live() -> Dependencies {
            let api = MantaAPIClient.live()
            return Dependencies(
                preview: { try await api.restorePreview() },
                restore: { try await api.restoreTopology() }
            )
        }
    }

    @Published private(set) var state: BackupPreviewState = .loading
    @Published private(set) var restoring = false
    /// The last restore's outcome line.
    @Published private(set) var outcome: (text: String, isError: Bool)?

    private let deps: Dependencies

    init(dependencies: Dependencies = .live()) {
        self.deps = dependencies
    }

    func loadPreview() async {
        do {
            state = .loaded(try await deps.preview())
        } catch {
            // The old preview is discarded, not shown stale.
            state = .failed(SettingsError.message(error))
        }
    }

    /// Returns true when the restore itself succeeded, so the caller can refresh
    /// the session list.
    @discardableResult
    func restore() async -> Bool {
        guard !restoring, BackupSummary.restoreEnabled(state) else { return false }
        restoring = true
        outcome = nil
        var succeeded = false
        do {
            let result = try await deps.restore()
            let line = BackupSummary.restoreOutcome(result)
            outcome = (line.text, !line.ok)
            succeeded = result.ok
        } catch {
            outcome = ("Couldn't restore your windows. \(SettingsError.message(error))", true)
        }
        restoring = false
        await loadPreview()
        return succeeded
    }
}

struct SettingsBackupScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var sessionStore: SessionListStore
    @StateObject private var model = SettingsBackupModel()

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "Restore windows") {
            Text(BackupSummary.intro)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .fixedSize(horizontal: false, vertical: true)

            switch model.state {
            case .loading:
                MantaLoader(caption: "Checking the saved layout…", tokens: tokens, size: .inline)
            case .failed(let reason):
                SettingsLoadFailure(message: "Couldn't load the saved window layout. \(reason)") {
                    Task { await model.loadPreview() }
                }
            case .loaded(let preview):
                Text(BackupSummary.statusLine(preview, formatDate: Self.format))
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("backup-status")
            }

            if BackupSummary.showsRestore(model.state) {
                Button {
                    Task {
                        if await model.restore() { await sessionStore.refresh() }
                    }
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        if model.restoring { ProgressView().tint(tokens.onAccent) }
                        Text(model.restoring ? "Restoring…" : "Restore windows")
                    }
                    .font(.manta(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Metrics.spacing.sp3)
                    .background(tokens.accentSolid, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
                }
                .buttonStyle(.plain)
                .disabled(model.restoring || !BackupSummary.restoreEnabled(model.state))
                .opacity(model.restoring || !BackupSummary.restoreEnabled(model.state) ? 0.4 : 1)
                .accessibilityIdentifier("backup-restore")
            }

            if let outcome = model.outcome {
                SettingsStatusLine(text: outcome.text, isError: outcome.isError, identifier: "backup-outcome")
            }
        }
        .task { await model.loadPreview() }
    }

    private static func format(_ epochMs: Double) -> String {
        Date(timeIntervalSince1970: epochMs / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
