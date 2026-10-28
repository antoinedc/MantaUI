import SwiftUI

// ===========================================================================
// WS10 F16 — Restart opencode. ONE helper backs both entry points: the Box
// section's "Restart opencode" row and the skill-registries banner (after a
// registry change the user is told a restart is needed). Restarting ends every
// agent turn in every session, so both ask first (callers own their confirm).
// ===========================================================================

enum SettingsOpencodeRestart {
    static let confirmTitle = "Restart opencode?"
    static let confirmMessage = "This ends every agent turn currently running in any session."
    static let confirmButton = "Restart"

    /// Never throws: a failure is `{ ok: false, error }`, so a caller can always
    /// show the outcome.
    static func run(api: MantaAPIClient) async -> OkResult {
        do {
            return try await api.opencodeRestart()
        } catch {
            return OkResult(ok: false, error: SettingsError.message(error))
        }
    }
}

@MainActor
final class OpencodeRestartModel: ObservableObject {
    enum State: Equatable {
        case idle
        case restarting
        case restarted
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private let runRestart: @Sendable () async -> OkResult

    init(run: @escaping @Sendable () async -> OkResult = { await SettingsOpencodeRestart.run(api: .live()) }) {
        self.runRestart = run
    }

    var isRestarting: Bool { state == .restarting }

    /// "opencode restarted." / "Restart failed: <error>" — nil until a result.
    var outcome: (text: String, isError: Bool)? {
        switch state {
        case .restarted: return ("opencode restarted.", false)
        case .failed(let message): return ("Restart failed: \(message)", true)
        case .idle, .restarting: return nil
        }
    }

    func restart() async {
        guard state != .restarting else { return }
        state = .restarting
        let result = await runRestart()
        state = result.ok ? .restarted : .failed(result.error ?? "unknown error")
    }

    func clearOutcome() {
        if state != .restarting { state = .idle }
    }
}

/// The Box section's "Restart opencode" row: confirm → spinner → outcome line.
struct SettingsOpencodeRestartRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var model = OpencodeRestartModel()
    @State private var confirming = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            Button {
                confirming = true
            } label: {
                HStack(spacing: Metrics.spacing.sp2) {
                    Text(model.isRestarting ? "Restarting…" : "Restart opencode")
                        .font(.manta(size: Metrics.type.body, weight: .medium))
                        .foregroundColor(tokens.tx1)
                    if model.isRestarting { ProgressView().tint(tokens.accent) }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.isRestarting)
            .accessibilityIdentifier("settings-restart-opencode")

            Text("Restarts the agent engine on your box. Every running agent turn ends.")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)

            if let outcome = model.outcome {
                Text(outcome.text)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(outcome.isError ? tokens.danger : tokens.ok)
                    .accessibilityIdentifier("settings-restart-opencode-outcome")
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .confirmationDialog(SettingsOpencodeRestart.confirmTitle, isPresented: $confirming, titleVisibility: .visible) {
            Button(SettingsOpencodeRestart.confirmButton, role: .destructive) {
                Task { await model.restart() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(SettingsOpencodeRestart.confirmMessage)
        }
    }
}
