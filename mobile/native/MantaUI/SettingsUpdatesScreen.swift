import SwiftUI
import Combine

// ===========================================================================
// WS10 F18 — Software updates. "Check for updates" asks the box whether it
// (Manta Server), opencode or an installed AI CLI has an update, and applies one.
//
// A server update restarts opencode, which ends every running agent turn — so it
// is confirmed first, exactly like the desktop. CLI updates are not disruptive and
// need no confirm. This app itself updates through TestFlight / the App Store, so
// its own version is informational only. Every outcome is visible: a failed
// check reads "Couldn't check" (never "Up to date"), a failed update shows its
// reason, and a restart that never confirms says so after ten minutes.
// ===========================================================================

struct SettingsUpdatesScreen: View {
    let eventStore: MantaEventStore?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @StateObject private var store = SettingsUpdatesStore()

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    var body: some View {
        SettingsSubScreen(title: "Software updates") {
            SettingsPanel {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                    infoRow("This app", appVersion)
                    infoRow("Manta Server", store.serverVersion.map { "v\($0)" } ?? "—")
                    Text("This app updates through TestFlight / the App Store.")
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundColor(tokens.tx4)
                }
            }

            HStack(spacing: Metrics.spacing.sp3) {
                Button {
                    Task { await store.check() }
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        if store.checking { ProgressView().tint(tokens.accent) }
                        Text(store.checking ? "Checking…" : "Check for updates")
                    }
                    .font(.manta(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
                }
                .buttonStyle(.plain)
                .disabled(store.checking)
                .accessibilityIdentifier("updates-check")
                Spacer()
                if let checkedAt = store.checkedAt {
                    Text("Checked \(checkedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx3)
                }
            }

            ForEach(store.targets) { target in
                row(target)
            }
        }
        .task { await store.check() }
        .onReceive(connectionPublisher) { store.connectionChanged(connected: $0) }
        .confirmationDialog(
            "Update Manta Server?",
            isPresented: Binding(
                get: { store.flow.phase == .confirming },
                set: { if !$0, store.flow.phase == .confirming { store.cancelServerUpdate() } }
            ),
            titleVisibility: .visible
        ) {
            Button("Update & restart", role: .destructive) { store.confirmServerUpdate() }
            Button("Cancel", role: .cancel) { store.cancelServerUpdate() }
        } message: {
            Text("This restarts opencode, which will end every agent turn currently running in any session. Any unsaved work in a running turn is lost.")
        }
    }

    /// The event stream's up/down edge; with no stream the box is assumed up.
    private var connectionPublisher: AnyPublisher<Bool, Never> {
        guard let eventStore else { return Empty<Bool, Never>().eraseToAnyPublisher() }
        return eventStore.$connectionState
            .map { $0.name == "connected" }
            .removeDuplicates()
            .eraseToAnyPublisher()
    }

    // MARK: - Rows

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx4)
            Spacer()
            Text(value)
                .font(.manta(size: Metrics.type.small, design: .monospaced))
                .foregroundColor(tokens.tx1)
        }
    }

    @ViewBuilder
    private func row(_ target: UpdateTarget) -> some View {
        let isServer = target.id == "server"
        SettingsPanel {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                HStack(spacing: Metrics.spacing.sp2) {
                    Circle()
                        .fill(dotColor(target))
                        .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
                    Text(target.label)
                        .font(.manta(size: Metrics.type.body, weight: .medium))
                        .foregroundColor(tokens.tx1)
                    Spacer()
                    if let versions = UpdateTargets.versionText(target) {
                        Text(versions)
                            .font(.manta(size: Metrics.type.xs, design: .monospaced))
                            .foregroundColor(tokens.tx3)
                    }
                }
                statusLine(target, isServer: isServer)
                action(target, isServer: isServer)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("updates-row-\(target.id)")
    }

    private func dotColor(_ target: UpdateTarget) -> Color {
        switch UpdateTargets.describe(target).tone {
        case .ok: return tokens.ok
        case .action: return tokens.accent
        case .muted: return tokens.tx4
        case .error: return tokens.danger
        }
    }

    /// The row's status wording; the server row narrates its own update.
    @ViewBuilder
    private func statusLine(_ target: UpdateTarget, isServer: Bool) -> some View {
        if isServer, let narration = serverNarration {
            HStack(spacing: Metrics.spacing.sp2) {
                if narration.busy { ProgressView().tint(tokens.accent) }
                Text(narration.text)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(narration.isError ? tokens.danger : (narration.busy ? tokens.tx2 : tokens.ok))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityIdentifier("updates-server-status")
        } else if let error = store.rowErrors[target.id] {
            Text(error)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.danger)
                .fixedSize(horizontal: false, vertical: true)
        } else if store.cliUpdatingID == target.id {
            HStack(spacing: Metrics.spacing.sp2) {
                ProgressView().tint(tokens.accent)
                Text("Updating…")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx2)
            }
        } else {
            let described = UpdateTargets.describe(target)
            Text(described.text)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(described.tone == .error ? tokens.danger : tokens.tx3)
        }
    }

    private var serverNarration: (text: String, busy: Bool, isError: Bool)? {
        switch store.flow.phase {
        case .idle, .confirming:
            return nil
        case .applying:
            return (store.flow.isWaitingForBox ? "Restarting the box…" : "Updating…", true, false)
        case .restarting:
            return ("Restarting the box…", true, false)
        case .done(let version):
            return ("Updated to v\(version)", false, false)
        case .failed(let message):
            return (message, false, true)
        case .timedOut:
            return (UpdateFlow.timedOutMessage, false, true)
        }
    }

    @ViewBuilder
    private func action(_ target: UpdateTarget, isServer: Bool) -> some View {
        if UpdateTargets.hasUpdate(target) {
            let disabled = store.isUpdating || store.checking
            Button {
                if isServer {
                    store.requestServerUpdate()
                } else {
                    Task { await store.updateCLI(target.id) }
                }
            } label: {
                Text("Update")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .padding(.horizontal, Metrics.spacing.sp4)
                    .padding(.vertical, Metrics.spacing.sp2)
                    .background(tokens.accentSolid, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .opacity(disabled ? 0.4 : 1)
            .accessibilityIdentifier("updates-update-\(target.id)")
        } else if target.ok, target.manual {
            if let urlText = target.manualUrl, let url = URL(string: urlText) {
                Button {
                    openURL(url)
                } label: {
                    Text("Update manually ↗")
                        .font(.manta(size: Metrics.type.small, weight: .semibold))
                        .foregroundColor(tokens.accentTx)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
