import SwiftUI

// ===========================================================================
// WS10 F10 — Skill registries. Extra registry URLs opencode fetches on startup
// (the default Manta registry is always included). Add / remove save at once
// through `config:update`; a failed save puts the list back and says so. A
// SUCCESSFUL change shows the "restart needed" banner — opencode only reads the
// registries at startup — whose button runs the same confirmed restart as the
// Box section's row.
// ===========================================================================

@MainActor
final class ExtensionsRegistriesModel: ObservableObject {

    @Published private(set) var urls: [String] = []
    @Published private(set) var loaded = false
    @Published private(set) var loadError: String?
    @Published private(set) var saving = false
    @Published private(set) var notice: (text: String, isError: Bool)?
    /// A registry change was saved and opencode has not been restarted since.
    @Published var restartNeeded = false
    @Published var newURL = ""

    private let api: MantaAPIClient

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    func load() async {
        do {
            guard let config = try await api.configGet() else {
                loadError = "The box sent no settings."
                return
            }
            urls = Self.urls(from: config)
            loadError = nil
            loaded = true
        } catch {
            loadError = SettingsError.message(error)
        }
    }

    func add() async {
        let trimmed = newURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }
        guard let next = ExtensionsRegistries.add(trimmed, to: urls) else {
            notice = ("That registry is already in the list.", true)
            return
        }
        if await persist(next) { newURL = "" }
    }

    func remove(_ url: String) async {
        await persist(ExtensionsRegistries.remove(url, from: urls))
    }

    /// Optimistic, one write at a time; reverts and reports on failure.
    @discardableResult
    private func persist(_ next: [String]) async -> Bool {
        guard !saving else { return false }
        let previous = urls
        urls = next
        saving = true
        notice = nil
        defer { saving = false }
        do {
            let merged = try await api.configUpdate(["skillRegistryUrls": next])
            if let merged { urls = Self.urls(from: merged) }
            restartNeeded = true
            return true
        } catch {
            urls = previous
            notice = ("Couldn't update skill registries.", true)
            return false
        }
    }

    private static func urls(from config: [String: JSONValue]) -> [String] {
        guard case .array(let items)? = config["skillRegistryUrls"] else { return [] }
        return items.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
    }
}

struct ExtensionsRegistriesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var model = ExtensionsRegistriesModel()
    @StateObject private var restart = OpencodeRestartModel()
    @State private var confirmRestart = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "Skill registries") {
            Text("Extra skill registry URLs fetched by opencode on startup. The default Manta registry is always included.")
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .fixedSize(horizontal: false, vertical: true)

            if model.restartNeeded { restartBanner }

            if let loadError = model.loadError {
                SettingsLoadFailure(message: "Couldn't load skill registries. \(loadError)") {
                    Task { await model.load() }
                }
            } else if !model.loaded {
                MantaLoader(caption: "Loading…", tokens: tokens, size: .inline)
            } else {
                list
                addField
            }

            if let notice = model.notice {
                SettingsStatusLine(text: notice.text, isError: notice.isError, identifier: "registries-notice")
            }
        }
        .task { await model.load() }
        .confirmationDialog(SettingsOpencodeRestart.confirmTitle, isPresented: $confirmRestart, titleVisibility: .visible) {
            Button(SettingsOpencodeRestart.confirmButton, role: .destructive) {
                Task {
                    await restart.restart()
                    if restart.state == .restarted { model.restartNeeded = false }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(SettingsOpencodeRestart.confirmMessage)
        }
    }

    @ViewBuilder
    private var list: some View {
        if model.urls.isEmpty {
            Text("No extra registries.")
                .font(.manta(size: Metrics.type.small))
                .foregroundColor(tokens.tx3)
        }
        ForEach(model.urls, id: \.self) { url in
            SettingsPanel {
                HStack(spacing: Metrics.spacing.sp2) {
                    Text(url)
                        .font(.manta(size: Metrics.type.small, design: .monospaced))
                        .foregroundColor(tokens.tx2)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Spacer(minLength: Metrics.spacing.sp2)
                    Button {
                        Task { await model.remove(url) }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.tx3)
                            .padding(Metrics.spacing.sp2)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.saving)
                    .accessibilityLabel("Remove registry URL")
                    .accessibilityIdentifier("registry-remove")
                }
            }
            .contextMenu {
                Button("Remove", role: .destructive) { Task { await model.remove(url) } }
            }
        }
    }

    private var addField: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            TextField("https://example.com/skills", text: $model.newURL)
                .font(.manta(size: Metrics.type.small, design: .monospaced))
                .textFieldStyle(.plain)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(Metrics.spacing.sp3)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                .onSubmit { Task { await model.add() } }
                .accessibilityIdentifier("registry-url-field")
            Button {
                Task { await model.add() }
            } label: {
                Text("Add")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.onAccent)
                    .padding(.horizontal, Metrics.spacing.sp4)
                    .padding(.vertical, Metrics.spacing.sp3)
                    .background(tokens.accentSolid, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            }
            .buttonStyle(.plain)
            .disabled(model.newURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.saving)
            .opacity(model.newURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.saving ? 0.4 : 1)
            .accessibilityIdentifier("registry-add")
        }
    }

    private var restartBanner: some View {
        SettingsPanel {
            VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                Text("Restart opencode to load the new registries. Restarting ends every running agent turn.")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Metrics.spacing.sp4) {
                    Button {
                        confirmRestart = true
                    } label: {
                        HStack(spacing: Metrics.spacing.sp2) {
                            if restart.isRestarting { ProgressView().tint(tokens.accent) }
                            Text(restart.isRestarting ? "Restarting…" : "Restart opencode")
                                .font(.manta(size: Metrics.type.small, weight: .semibold))
                                .foregroundColor(tokens.accentTx)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(restart.isRestarting)
                    .accessibilityIdentifier("registry-restart")
                    Button {
                        model.restartNeeded = false
                    } label: {
                        Text("Later")
                            .font(.manta(size: Metrics.type.small, weight: .medium))
                            .foregroundColor(tokens.tx3)
                    }
                    .buttonStyle(.plain)
                    .disabled(restart.isRestarting)
                }
                if let outcome = restart.outcome {
                    SettingsStatusLine(text: outcome.text, isError: outcome.isError, identifier: "registry-restart-outcome")
                }
            }
        }
    }
}
