import SwiftUI

// ===========================================================================
// WS10 F12 — CLI launch options. Flags used when a session starts an AI CLI
// (e.g. Claude Code) directly in its terminal; only CLIs installed on the box are
// listed, and only ones that have flags. Each toggle writes the launcher's FULL
// resolved flag map (`ExtensionsLaunchers.update`), awaited and serialized — all
// toggles are disabled while one saves, a failure puts the value back and says
// so, and a success adopts the map the box returns.
// ===========================================================================

@MainActor
final class ExtensionsLaunchersModel: ObservableObject {

    enum Load: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var load: Load = .loading
    @Published private(set) var launchers: [AvailableLauncher] = []
    @Published private(set) var saved: [String: [String: Bool]] = [:]
    @Published private(set) var saving = false
    @Published private(set) var notice: String?

    private let api: MantaAPIClient

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    func reload() async {
        load = .loading
        async let list = api.launchersList()
        async let config = api.configGet()
        do {
            let (found, current) = try await (list, config)
            launchers = found
            saved = ExtensionsLaunchers.savedFlags(from: current)
            load = .loaded
        } catch {
            load = .failed(SettingsError.message(error))
        }
    }

    /// Launchers that have at least one boolean flag.
    var launchersWithFlags: [AvailableLauncher] {
        launchers.filter { $0.flags.contains { $0.type == "boolean" } }
    }

    func value(launcher: AvailableLauncher, flag: AvailableLauncherFlag) -> Bool {
        ExtensionsLaunchers.resolve(schema: launcher.flags, saved: saved[launcher.id])[flag.key] ?? flag.default
    }

    func set(launcher: AvailableLauncher, flag: AvailableLauncherFlag, checked: Bool) async {
        guard !saving else { return }
        let previous = saved
        let next = ExtensionsLaunchers.update(
            launchers: launchers, launcherID: launcher.id, flagKey: flag.key, checked: checked, prev: saved)
        saved = next
        saving = true
        notice = nil
        do {
            let merged = try await api.configUpdate(["launcherFlags": ExtensionsLaunchers.payload(next)])
            if merged != nil { saved = ExtensionsLaunchers.savedFlags(from: merged) }
        } catch {
            saved = previous
            notice = "Couldn't save launcher flag."
        }
        saving = false
    }
}

struct ExtensionsLaunchersScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var sessionStore: SessionListStore
    @StateObject private var model = ExtensionsLaunchersModel()

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "CLI launch options") {
            Text("Flags used when launching an AI CLI (e.g. Claude Code) directly in a session's terminal. Only CLIs detected on this server are shown.")
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .fixedSize(horizontal: false, vertical: true)

            switch model.load {
            case .loading:
                MantaLoader(caption: "Loading…", tokens: tokens, size: .inline)
            case .failed(let reason):
                SettingsLoadFailure(message: "Couldn't load the AI CLIs on your box. \(reason)") {
                    Task { await model.reload() }
                }
            case .loaded:
                if model.launchersWithFlags.isEmpty {
                    Text("No AI CLI with launch options is installed on your box.")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx3)
                }
                ForEach(model.launchersWithFlags) { launcher in
                    launcherSection(launcher)
                }
            }

            if let notice = model.notice {
                SettingsStatusLine(text: notice, isError: true, identifier: "launchers-notice")
            }
        }
        .task { await model.reload() }
        // The session list caches these flags for new sessions; refresh it.
        .onDisappear { sessionStore.loadConfig() }
    }

    private func launcherSection(_ launcher: AvailableLauncher) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text(launcher.label)
                .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                .foregroundColor(tokens.tx2)
                .textCase(.uppercase)
            SettingsPanel {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                    ForEach(launcher.flags.filter { $0.type == "boolean" }, id: \.key) { flag in
                        HStack {
                            Text(flag.label)
                                .font(.manta(size: Metrics.type.body))
                                .foregroundColor(tokens.tx1)
                            Spacer()
                            if model.saving { ProgressView().tint(tokens.accent) }
                            Toggle("", isOn: Binding(
                                get: { model.value(launcher: launcher, flag: flag) },
                                set: { checked in Task { await model.set(launcher: launcher, flag: flag, checked: checked) } }
                            ))
                            .labelsHidden()
                            .tint(tokens.accent)
                            .disabled(model.saving)
                            .accessibilityIdentifier("launcher-\(launcher.id)-\(flag.key)")
                        }
                    }
                }
            }
        }
    }
}
