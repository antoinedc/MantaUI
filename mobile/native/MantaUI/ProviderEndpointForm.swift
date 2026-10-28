import SwiftUI

// ===========================================================================
// WS08 — "Add endpoint…" (the form's behaviour lives in
// `ProviderEndpointFormModel.swift`): name, base URL, optional key → Test
// endpoint → a checklist of the endpoint's models → Save N models.
// ===========================================================================

// MARK: - View

struct ProviderEndpointForm: View {
    @StateObject private var model: ProviderEndpointFormModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(connections: ProviderConnectionsStore, accounts: AccountsStore) {
        _model = StateObject(wrappedValue: ProviderEndpointFormModel(connections: connections, accounts: accounts))
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        Form {
            endpointSection
            if model.checklist != nil { modelsSection }
        }
        .navigationTitle("Add endpoint")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: model.shouldDismiss) { _, shouldDismiss in
            if shouldDismiss { dismiss() }
        }
    }

    // MARK: Endpoint

    private var endpointSection: some View {
        Section {
            TextField("Name (e.g. VoskaAI)", text: $model.name)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(model.isBusy)
            if !model.slug.isEmpty {
                Text("Provider id: \(model.slug)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            TextField("Base URL (https://api.example.com/v1)", text: $model.baseURL)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(model.isBusy)
            SecureField("API key (optional)", text: $model.apiKey)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(model.isBusy)
            if let message = model.visibleValidationError {
                Text(message)
                    .font(.footnote)
                    .foregroundColor(tokens.warn)
            }
            if let error = model.testError {
                Text(error)
                    .font(.footnote)
                    .foregroundColor(tokens.danger)
            }
            Button {
                Task { await model.test() }
            } label: {
                if model.phase == .testing {
                    HStack(spacing: Metrics.spacing.sp2) {
                        ProgressView()
                        Text("Testing…")
                    }
                } else {
                    Text("Test endpoint")
                }
            }
            .disabled(!model.canTest)
        } header: {
            Text("Endpoint")
        } footer: {
            Text("The key is optional. It is stored on your box and never shown again.")
        }
    }

    // MARK: Models

    @ViewBuilder
    private var modelsSection: some View {
        if let checklist = model.checklist {
            Section {
                TextField("Filter \(checklist.ids.count) models…", text: Binding(
                    get: { checklist.filter },
                    set: { model.setFilter($0) }
                ))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                HStack {
                    Text(checklist.countsLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("All") { model.selectAllVisible() }
                        .disabled(checklist.allChecked || model.isBusy)
                    Button("None") { model.selectNoneVisible() }
                        .disabled(checklist.noneChecked || model.isBusy)
                }
                .buttonStyle(.borderless)
                if let empty = checklist.emptyMessage {
                    Text(empty)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(checklist.visible, id: \.self) { id in
                    Toggle(isOn: Binding(
                        get: { model.checklist?.isSelected(id) ?? false },
                        set: { model.setModel(id, selected: $0) }
                    )) {
                        Text(id).font(.system(.body, design: .monospaced))
                    }
                    .disabled(model.isBusy)
                }
            } header: {
                Text("Models")
            } footer: {
                if !checklist.canSave { Text(ProviderEndpointDraft.selectAtLeastOne) }
            }

            Section {
                if let error = model.saveError {
                    Text(error)
                        .font(.footnote)
                        .foregroundColor(tokens.danger)
                }
                Button {
                    Task { await model.save() }
                } label: {
                    if model.phase == .saving {
                        HStack(spacing: Metrics.spacing.sp2) {
                            ProgressView()
                            Text("Saving…")
                        }
                    } else {
                        Text(checklist.saveTitle)
                    }
                }
                .disabled(!checklist.canSave || model.isBusy)
            }
        }
    }
}
