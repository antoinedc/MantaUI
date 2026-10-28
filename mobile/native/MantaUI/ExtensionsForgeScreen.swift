import SwiftUI

// ===========================================================================
// WS10 F9 — GitHub connection + forge rules (Settings → Extensions).
//
// The GitHub row says who is connected and where the credential came from (the
// pure `ExtensionsForge.secondary`), and offers Disconnect behind a confirm.
// CONNECTING is WS05's device-flow sign-in in the chat's git sheet — Settings
// does not duplicate it, so "Not connected." is a statement, not a dead button.
// Forge rules are written on the box by the AI; this screen lists them (invalid
// ones with their error, verbatim — a rules file that silently fails to load is
// worse than one that loudly refuses) and carries the one global switch.
// ===========================================================================

@MainActor
final class ExtensionsForgeModel: ObservableObject {

    enum StatusState: Equatable {
        case loading
        case loaded(ForgeConnectionStatus)
        case failed(String)
    }

    @Published private(set) var status: StatusState = .loading
    @Published private(set) var rulesEnabled = false
    /// The config was read, so `rulesEnabled` is the box's value, not a guess.
    @Published private(set) var rulesLoaded = false
    @Published private(set) var savingToggle = false
    @Published private(set) var rules: [ForgeRuleRow]?
    @Published private(set) var rulesError: String?
    @Published private(set) var disconnecting = false
    @Published private(set) var notice: (text: String, isError: Bool)?

    private let api: MantaAPIClient

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    func loadStatus() async {
        async let config = try? api.configGet()
        do {
            status = .loaded(try await api.forgeStatus(validate: true))
        } catch {
            status = .failed(SettingsError.message(error))
        }
        // Only a successful read confirms the toggle: a failed one leaves it
        // disabled (see `rulesLoaded`) instead of showing an unconfirmed "off".
        if let loaded = await config {
            if case .bool(let on)? = loaded["forgeRulesEnabled"] { rulesEnabled = on } else { rulesEnabled = false }
            rulesLoaded = true
        } else {
            rulesLoaded = false
        }
    }

    func loadRules() async {
        do {
            rules = try await api.forgeRulesList()
            rulesError = nil
        } catch {
            rulesError = SettingsError.message(error)
        }
    }

    /// Optimistic; reverted with a visible error when the box refuses.
    func setRulesEnabled(_ on: Bool) async {
        guard !savingToggle, rulesLoaded else { return }
        let previous = rulesEnabled
        rulesEnabled = on
        savingToggle = true
        notice = nil
        do {
            _ = try await api.configUpdate(["forgeRulesEnabled": on])
        } catch {
            rulesEnabled = previous
            notice = ("Couldn't change forge rules.", true)
        }
        savingToggle = false
    }

    func disconnect() async {
        guard !disconnecting else { return }
        disconnecting = true
        notice = nil
        do {
            let result = try await api.forgeDisconnect()
            if result.ok {
                status = .loaded(ForgeConnectionStatus(connected: false))
                notice = ("Disconnected GitHub. Your gh CLI is untouched — Manta will ignore it until you reconnect.", false)
            } else {
                notice = ("Couldn't disconnect GitHub. \(result.error ?? "unknown error")", true)
            }
        } catch {
            notice = ("Couldn't disconnect GitHub. \(SettingsError.message(error))", true)
        }
        disconnecting = false
    }
}

struct ExtensionsForgeScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var model = ExtensionsForgeModel()
    @State private var confirmDisconnect = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "GitHub and forge rules") {
            sectionTitle("GitHub")
            githubRow

            sectionTitle("Forge rules")
            SettingsPanel {
                Toggle(isOn: Binding(
                    get: { model.rulesEnabled },
                    set: { on in Task { await model.setRulesEnabled(on) } }
                )) {
                    Text("Let forge rules start agents on this server")
                        .font(.manta(size: Metrics.type.body))
                        .foregroundColor(tokens.tx1)
                }
                .tint(tokens.accent)
                .disabled(model.savingToggle || !model.rulesLoaded)
                .accessibilityIdentifier("forge-rules-enabled")
            }

            if !model.rulesLoaded, model.status != .loading {
                SettingsLoadFailure(message: "Couldn't read this setting.") {
                    Task { await model.loadStatus() }
                }
            }

            if let notice = model.notice {
                SettingsStatusLine(text: notice.text, isError: notice.isError, identifier: "forge-notice")
            }

            rulesList
        }
        .task { await model.loadStatus() }
        .task {
            while !Task.isCancelled {
                await model.loadRules()
                try? await Task.sleep(for: .seconds(10))
            }
        }
        .confirmationDialog("Disconnect GitHub?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { Task { await model.disconnect() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your gh CLI on the box is not signed out — Manta just stops using it until you reconnect.")
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
            .foregroundColor(tokens.tx2)
            .textCase(.uppercase)
            .padding(.top, Metrics.spacing.sp2)
    }

    @ViewBuilder
    private var githubRow: some View {
        switch model.status {
        case .loading:
            SettingsPanel {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView().tint(tokens.accent)
                    Text("GitHub · Checking…")
                        .font(.manta(size: Metrics.type.body))
                        .foregroundColor(tokens.tx3)
                }
            }
        case .failed(let reason):
            SettingsLoadFailure(message: "Couldn't check the GitHub connection. \(reason)") {
                Task { await model.loadStatus() }
            }
        case .loaded(let status):
            SettingsPanel {
                HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
                    Circle()
                        .fill(status.connected ? (status.valid == false ? tokens.warn : tokens.ok) : tokens.tx4)
                        .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
                        .padding(.top, Metrics.spacing.sp1)
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                        Text("GitHub")
                            .font(.manta(size: Metrics.type.body, weight: .medium))
                            .foregroundColor(tokens.tx1)
                        Text(status.connected
                             ? ExtensionsForge.secondary(login: status.login, source: status.source, valid: status.valid)
                             : "Not connected.")
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(status.valid == false ? tokens.warn : tokens.tx3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    if status.connected {
                        Button {
                            confirmDisconnect = true
                        } label: {
                            if model.disconnecting {
                                ProgressView().tint(tokens.accent)
                            } else {
                                Text("Disconnect")
                                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                                    .foregroundColor(tokens.danger)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(model.disconnecting)
                        .accessibilityIdentifier("forge-disconnect")
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var rulesList: some View {
        if let rulesError = model.rulesError {
            SettingsLoadFailure(message: "Couldn't load the forge rules list. \(rulesError)") {
                Task { await model.loadRules() }
            }
        }
        if let rules = model.rules {
            if rules.isEmpty, model.rulesError == nil {
                Text("No forge rules yet. The AI authors them on the server with forge_rules.save; each is a YAML file at ~/.manta/forge-rules/.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(rules) { rule in
                SettingsPanel {
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                        HStack(spacing: Metrics.spacing.sp2) {
                            Circle()
                                .fill(rule.valid ? tokens.ok : tokens.danger)
                                .frame(width: Metrics.spacing.sp2, height: Metrics.spacing.sp2)
                            Text(rule.repoKey)
                                .font(.manta(size: Metrics.type.body, weight: .medium))
                                .foregroundColor(tokens.tx1)
                            Spacer()
                            if rule.valid {
                                Text("\(ExtensionsFormat.ruleCountText(rule.ruleCount)) · valid")
                                    .font(.manta(size: Metrics.type.xs))
                                    .foregroundColor(tokens.tx3)
                            }
                        }
                        if !rule.valid {
                            Text(rule.error ?? "invalid")
                                .font(.manta(size: Metrics.type.small))
                                .foregroundColor(tokens.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        } else if model.rulesError == nil {
            MantaLoader(caption: "Loading forge rules…", tokens: tokens, size: .inline)
        }
    }
}
