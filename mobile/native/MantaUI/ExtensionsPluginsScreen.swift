import SwiftUI

// ===========================================================================
// WS10 F8 — Plugins (view only). A plugin is a YAML file on the user's MAC; the
// Mac executor publishes the list to the box and runs the plugins there. The
// phone therefore shows the list but has no on/off switch and no "open folder" —
// both live in the Mac app (the toggle is Mac-local storage the box never sees).
// Refreshes every ten seconds while the screen is up, like the desktop.
// ===========================================================================

struct ExtensionsPluginsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var rows: [PluginRegistryRow]?
    @State private var loadError: String?
    @State private var selected: PluginRegistryRow?

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "Plugins") {
            Text("Plugins run on your Mac. Turn them on or off in Manta on your Mac (Settings → Extensions).")
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .fixedSize(horizontal: false, vertical: true)

            if let loadError {
                SettingsLoadFailure(message: "Couldn't load the plugins list. \(loadError)") {
                    Task { await load() }
                }
            }

            if let rows {
                if rows.isEmpty, loadError == nil {
                    Text("No plugins are installed on your Mac — or plugins are turned off there.")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(rows) { row in
                    pluginRow(row)
                }
            } else if loadError == nil {
                MantaLoader(caption: "Loading plugins…", tokens: tokens, size: .inline)
            }
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(10))
            }
        }
        .sheet(item: $selected) { row in
            PluginYAMLSheet(row: row)
        }
    }

    private func load() async {
        do {
            rows = try await MantaAPIClient.live().pluginsRegistry()
            loadError = nil
        } catch {
            loadError = SettingsError.message(error)
        }
    }

    private func pluginRow(_ row: PluginRegistryRow) -> some View {
        Button {
            selected = row
        } label: {
            SettingsPanel {
                VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                    HStack(alignment: .firstTextBaseline, spacing: Metrics.spacing.sp2) {
                        Text(row.name)
                            .font(.manta(size: Metrics.type.body, weight: .medium))
                            .foregroundColor(tokens.tx1)
                        if row.valid {
                            Text("valid")
                                .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                                .foregroundColor(tokens.ok)
                        }
                        Spacer()
                        Text(ExtensionsFormat.stepsLine(stepCount: row.stepCount, timeoutMs: row.timeoutMs))
                            .font(.manta(size: Metrics.type.xs))
                            .foregroundColor(tokens.tx4)
                    }
                    if !row.valid {
                        Text("parse error: \(row.error ?? "unknown")")
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !row.description.isEmpty {
                        Text(row.description)
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.tx3)
                            .multilineTextAlignment(.leading)
                    }
                    if let inputs = ExtensionsFormat.inputsLine(row.inputs) {
                        Text(inputs)
                            .font(.manta(size: Metrics.type.xs))
                            .foregroundColor(tokens.tx4)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("plugin-\(row.name)")
    }
}

/// The plugin's YAML, read-only and selectable (copy via the system menu).
private struct PluginYAMLSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    let row: PluginRegistryRow

    var body: some View {
        let tokens = Tokens.scheme(colorScheme)
        NavigationStack {
            ScrollView {
                Text(row.yaml.isEmpty ? "No source available." : row.yaml)
                    .font(.manta(size: Metrics.type.small, design: .monospaced))
                    .foregroundColor(tokens.tx1)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Metrics.spacing.sp3)
            }
            .background(tokens.canvas.ignoresSafeArea())
            .navigationTitle(row.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
