import SwiftUI

// ===========================================================================
// WS10 F11 — References. A reference is an external folder or git repository
// opencode can read, attached in chat with `@alias`. This screen lists them and
// adds one (desktop parity: there is no remove yet — the box supports it, the
// desktop says "Removing a reference isn't available yet", and so does this).
//
// The list comes from WS03's `references()` (one reader, D16); the write is
// WS10's `opencodeSetReferences(upsert:)`, which hot-applies on the box.
// ===========================================================================

@MainActor
final class ExtensionsReferencesModel: ObservableObject {

    @Published private(set) var references: [OpencodeReferenceInfo]?
    @Published private(set) var loadError: String?
    @Published var alias = ""
    @Published var target = ""
    @Published var details = ""
    @Published private(set) var aliasError: String?
    @Published private(set) var targetError: String?
    @Published private(set) var adding = false
    @Published private(set) var notice: (text: String, isError: Bool)?

    private let api: MantaAPIClient

    init(api: MantaAPIClient = .live()) {
        self.api = api
    }

    var canAdd: Bool {
        !alias.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func load() async {
        do {
            references = try await api.references()
            loadError = nil
        } catch {
            loadError = SettingsError.message(error)
        }
    }

    func clearFieldErrors() {
        aliasError = nil
        targetError = nil
    }

    func add() async {
        guard !adding else { return }
        notice = nil
        let aliasProblem = ExtensionsReferences.validateAlias(alias)
        aliasError = aliasProblem
        if target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            targetError = ExtensionsReferences.targetRequired
            return
        }
        targetError = nil
        if aliasProblem != nil { return }

        adding = true
        defer { adding = false }
        let upsert = ExtensionsReferences.upsertPayload(alias: alias, target: target, description: details)
        do {
            let result = try await api.opencodeSetReferences(upsert: [upsert])
            guard result.ok else {
                notice = ("Couldn't add reference: \(result.error ?? "unknown error")", true)
                return
            }
            alias = ""
            target = ""
            details = ""
            clearFieldErrors()
            await load()
            notice = ("Reference added", false)
        } catch {
            notice = ("Couldn't add reference: \(SettingsError.message(error))", true)
        }
    }
}

struct ExtensionsReferencesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var model = ExtensionsReferencesModel()

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        SettingsSubScreen(title: "References") {
            Text("Add an external directory or git repository as an opencode reference. Type @alias in the chat to attach it, or @alias/… to search inside it. Agents can read a reference's files without a permission prompt. Removing a reference isn't available yet.")
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx3)
                .fixedSize(horizontal: false, vertical: true)

            if let loadError = model.loadError {
                SettingsLoadFailure(message: "Couldn't load references. \(loadError)") {
                    Task { await model.load() }
                }
            }
            if let references = model.references {
                if references.isEmpty, model.loadError == nil {
                    Text("No references configured.")
                        .font(.manta(size: Metrics.type.small))
                        .foregroundColor(tokens.tx3)
                }
                ForEach(references, id: \.name) { reference in
                    SettingsPanel {
                        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                            Text(ExtensionsReferences.displayTarget(
                                name: reference.name, path: reference.path,
                                repository: reference.repository, branch: reference.branch))
                                .font(.manta(size: Metrics.type.small, design: .monospaced))
                                .foregroundColor(tokens.tx2)
                                .textSelection(.enabled)
                            if let description = reference.description, !description.isEmpty {
                                Text(description)
                                    .font(.manta(size: Metrics.type.xs))
                                    .foregroundColor(tokens.tx3)
                            }
                        }
                    }
                }
            } else if model.loadError == nil {
                MantaLoader(caption: "Loading…", tokens: tokens, size: .inline)
            }

            Text("Add a reference")
                .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                .foregroundColor(tokens.tx2)
                .textCase(.uppercase)
                .padding(.top, Metrics.spacing.sp2)

            field("alias", text: $model.alias, error: model.aliasError, identifier: "reference-alias")
            field("path or repository — e.g. ../docs or owner/repo", text: $model.target,
                  error: model.targetError, identifier: "reference-target")
            field("optional description", text: $model.details, error: nil, identifier: "reference-description")

            Button {
                Task { await model.add() }
            } label: {
                HStack(spacing: Metrics.spacing.sp2) {
                    if model.adding { ProgressView().tint(tokens.onAccent) }
                    Text(model.adding ? "Adding…" : "Add")
                }
                .font(.manta(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.onAccent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Metrics.spacing.sp3)
                .background(tokens.accentSolid, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
            }
            .buttonStyle(.plain)
            .disabled(!model.canAdd || model.adding)
            .opacity(!model.canAdd || model.adding ? 0.4 : 1)
            .accessibilityIdentifier("reference-add")

            if let notice = model.notice {
                SettingsStatusLine(text: notice.text, isError: notice.isError, identifier: "references-notice")
            }
        }
        .task { await model.load() }
    }

    private func field(_ placeholder: String, text: Binding<String>, error: String?, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
            TextField(placeholder, text: text)
                .font(.manta(size: Metrics.type.body))
                .textFieldStyle(.plain)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(Metrics.spacing.sp3)
                .background(tokens.inset, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
                .onChange(of: text.wrappedValue) { _, _ in model.clearFieldErrors() }
                .onSubmit { Task { await model.add() } }
                .accessibilityIdentifier(identifier)
            if let error {
                Text(error)
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.danger)
            }
        }
    }
}
