import SwiftUI

// ===========================================================================
// WS10 §0 — the real views behind the schema's phone-only `custom` anchors.
//
// `SettingsScreen` renders the generated inventory; a `custom` entry has no value
// of its own, so it asks `SettingsCustomRow` for its surface: a NavigationLink
// row (a sub-screen), an inline card, or an action row. An id this file does not
// know (e.g. `accountsList`, which the screen draws itself) falls back to the
// screen's plain label row — see `SettingsCustomRow.handles`.
// ===========================================================================

struct SettingsCustomRow: View {
    let entry: SettingEntry
    let eventStore: MantaEventStore?
    @ObservedObject var removal: BoxRemovalStore

    /// The anchor ids this file draws.
    static func handles(_ id: String) -> Bool {
        switch id {
        case "updatesMobile", "backupMobile", "boxStatusMobile", "addDeviceMobile", "linkedDevicesMobile",
             "restartOpencodeMobile", "removeServerMobile", "pluginsListMobile", "forgeMobile",
             "skillRegistriesMobile", "referencesMobile", "launcherFlagsMobile":
            return true
        default:
            return false
        }
    }

    var body: some View {
        switch entry.id {
        case "updatesMobile":
            SettingsNavRow(entry: entry) { SettingsUpdatesScreen(eventStore: eventStore) }
        case "backupMobile":
            SettingsNavRow(entry: entry) { SettingsBackupScreen() }
        case "boxStatusMobile":
            BoxStatusCard(eventStore: eventStore)
        case "addDeviceMobile":
            SettingsNavRow(entry: entry) { BoxAddDeviceScreen() }
        case "linkedDevicesMobile":
            SettingsNavRow(entry: entry) { BoxDevicesScreen() }
        case "restartOpencodeMobile":
            SettingsOpencodeRestartRow()
        case "removeServerMobile":
            BoxRemoveServerRow(removal: removal)
        case "pluginsListMobile":
            SettingsNavRow(entry: entry) { ExtensionsPluginsScreen() }
        case "forgeMobile":
            SettingsNavRow(entry: entry) { ExtensionsForgeScreen() }
        case "skillRegistriesMobile":
            SettingsNavRow(entry: entry) { ExtensionsRegistriesScreen() }
        case "referencesMobile":
            SettingsNavRow(entry: entry) { ExtensionsReferencesScreen() }
        case "launcherFlagsMobile":
            SettingsNavRow(entry: entry) { ExtensionsLaunchersScreen() }
        default:
            EmptyView()
        }
    }
}

// MARK: - Shared atoms

/// A tappable row that pushes a sub-screen: the entry's label + help and a chevron.
struct SettingsNavRow<Destination: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let entry: SettingEntry
    @ViewBuilder let destination: Destination

    var body: some View {
        let tokens = Tokens.scheme(colorScheme)
        NavigationLink {
            destination
        } label: {
            HStack(spacing: Metrics.spacing.sp2) {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    Text(entry.label)
                        .font(.manta(size: Metrics.type.body, weight: .medium))
                        .foregroundColor(tokens.tx1)
                    if !entry.help.isEmpty {
                        Text(entry.help)
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.tx3)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx4)
            }
            .padding(.horizontal, Metrics.spacing.sp3)
            .padding(.vertical, Metrics.spacing.sp2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-\(entry.id)")
    }
}

/// The frame of a Settings sub-screen: canvas, scroll, inline title.
struct SettingsSubScreen<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        let tokens = Tokens.scheme(colorScheme)
        ZStack {
            tokens.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
                    content
                }
                .padding(Metrics.spacing.sp3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A status line under a control: ok tone or danger tone.
struct SettingsStatusLine: View {
    @Environment(\.colorScheme) private var colorScheme
    let text: String
    var isError = false
    var identifier: String?

    var body: some View {
        let tokens = Tokens.scheme(colorScheme)
        Text(text)
            .font(.manta(size: Metrics.type.small))
            .foregroundColor(isError ? tokens.danger : tokens.ok)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(identifier ?? "settings-status")
    }
}

/// A "Couldn't load … <error>" block with a "Try again" button.
struct SettingsLoadFailure: View {
    @Environment(\.colorScheme) private var colorScheme
    let message: String
    let retry: () -> Void

    var body: some View {
        let tokens = Tokens.scheme(colorScheme)
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text(message)
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.danger)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: retry) {
                Text("Try again")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings-try-again")
        }
    }
}

/// A rounded panel used for list rows on the Extensions / Box screens.
struct SettingsPanel<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @ViewBuilder let content: Content

    var body: some View {
        let tokens = Tokens.scheme(colorScheme)
        content
            .padding(Metrics.spacing.sp3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.md)
                    .stroke(tokens.border, lineWidth: 1)
            )
    }
}

// MARK: - Remove server

/// The danger row in the Box section. Every state of `BoxRemovalStore` has its
/// own visible treatment: the confirmation, the spinner, the Keychain-failure
/// alert (with "Try again"), and the warning that must be acknowledged before the
/// app leaves.
struct BoxRemoveServerRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject var removal: BoxRemovalStore

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            Button {
                removal.begin()
            } label: {
                HStack(spacing: Metrics.spacing.sp2) {
                    Text(removal.isBusy ? "Removing…" : "Remove server")
                        .font(.manta(size: Metrics.type.body, weight: .medium))
                        .foregroundColor(tokens.danger)
                    if removal.isBusy { ProgressView().tint(tokens.danger) }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(removal.isBusy)
            .accessibilityIdentifier("settings-remove-server")

            Text("Forget this box on this phone and sign this phone out of it.")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
    }
}

/// The Remove-server confirmation and both of its alerts (Keychain failure with
/// "Try again", and the warning that must be acknowledged before the app
/// leaves). Applied to the Settings screen ITSELF — which is always mounted —
/// rather than to the Box row, which unmounts when the user searches; an alert
/// attached to an unmounted row can never appear, and the warning would be lost.
struct BoxRemovalPresentation: ViewModifier {
    @ObservedObject var removal: BoxRemovalStore

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Remove this server?", isPresented: confirmBinding, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { removal.confirm() }
                Button("Cancel", role: .cancel) { removal.cancel() }
            } message: {
                Text("This phone forgets the box and signs itself out of it. Your desktop and other devices stay connected. To use this box again you'll need a new pairing code.\n\nNotifications this box already sends to this phone may keep arriving. To stop them now, turn off notifications for Manta in iOS Settings.")
            }
            .alert(alertTitle, isPresented: alertBinding) {
                alertActions
            } message: {
                Text(alertMessage)
            }
    }

    private var confirmBinding: Binding<Bool> {
        Binding(
            get: { removal.state == .confirming },
            set: { shown in
                if !shown, removal.state == .confirming { removal.cancel() }
            }
        )
    }

    private var alertBinding: Binding<Bool> {
        Binding(
            get: {
                switch removal.state {
                case .localDeleteFailed, .warning: return true
                default: return false
                }
            },
            // Both alerts are closed by their own buttons, which move the state.
            set: { _ in }
        )
    }

    private var alertTitle: String {
        if case .localDeleteFailed = removal.state { return "Couldn't remove this box from this phone" }
        return "Removed from this phone"
    }

    private var alertMessage: String {
        switch removal.state {
        case .localDeleteFailed(_, let error):
            return "The box sign-in is still saved on this phone (\(error)). Nothing else changed on this phone."
        case .warning(let message):
            return message
        default:
            return ""
        }
    }

    @ViewBuilder
    private var alertActions: some View {
        if case .localDeleteFailed = removal.state {
            Button("Try again") { removal.retryLocal() }
            Button("Cancel", role: .cancel) { removal.cancel() }
        } else {
            Button("OK") { removal.acknowledge() }
        }
    }
}
