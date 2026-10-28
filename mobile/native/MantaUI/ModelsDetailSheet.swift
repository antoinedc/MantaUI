import SwiftUI

// ===========================================================================
// WS09 F1 — one model's controls: show in the picker, available as a subagent,
// make default, edit name / description / context, enable a deprecated model.
// Driven by the box's row (`models:table`); a write replaces the table with the
// reply's, so the sheet re-renders from the box's answer.
// ===========================================================================

struct ModelsDetailSheet: View {
    @ObservedObject var store: ModelsStore
    let key: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmHideDefault = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        NavigationStack {
            Group {
                if let row = store.row(key: key) {
                    form(row)
                } else {
                    ContentUnavailableView("That model is no longer on this box.", systemImage: "questionmark.circle")
                }
            }
            .navigationTitle(store.row(key: key)?.name ?? "Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                ModelsFeedbackBar(feedback: store.feedback, tokens: tokens,
                                  retry: { Task { await store.retrySubSync() } },
                                  dismiss: { store.dismissFeedback() })
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var busy: Bool { store.busyKey != nil }

    @ViewBuilder
    private func form(_ row: ModelsTableRowWire) -> some View {
        Form {
            Section {
                LabeledContent("Provider", value: UsageMeters.providerLabel(row.providerID))
                if let ctx = row.contextLabel { LabeledContent("Context", value: ctx) }
                if let tier = row.tier { LabeledContent("Tier", value: tier) }
                if let description = row.description, !description.isEmpty {
                    Text(description).font(.footnote).foregroundStyle(.secondary)
                }
            }

            if row.deprecatedLocked {
                Section {
                    Label("This model is deprecated.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(tokens.warn)
                    Button {
                        Task { await store.optIn(key: row.key) }
                    } label: {
                        HStack {
                            Text("Enable deprecated model")
                            Spacer()
                            if store.busyKey == row.key { ProgressView() }
                        }
                    }
                    .disabled(busy)
                } footer: {
                    Text("Also registers it as a subagent.")
                }
            } else {
                controls(row)
            }
        }
        .confirmationDialog(
            "This is your default model. Hiding it also clears the default.",
            isPresented: $confirmHideDefault,
            titleVisibility: .visible
        ) {
            Button("Hide and clear default", role: .destructive) {
                Task { await store.setMain(key: row.key, on: false) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func controls(_ row: ModelsTableRowWire) -> some View {
        Section {
            Toggle("Show in model picker", isOn: Binding(
                get: { row.isMain },
                set: { on in
                    if !on && row.isDefault {
                        confirmHideDefault = true
                    } else {
                        Task { await store.setMain(key: row.key, on: on) }
                    }
                }
            ))
            .disabled(busy)
            Toggle("Available as subagent", isOn: Binding(
                get: { row.isSub },
                set: { on in Task { await store.setSub(key: row.key, on: on) } }
            ))
            .disabled(busy)
            if store.busyKey == row.key {
                HStack(spacing: Metrics.spacing.sp2) {
                    ProgressView()
                    Text("Saving…").foregroundStyle(.secondary)
                }
            }
        }

        Section {
            if row.isDefault {
                Label("Default model", systemImage: "checkmark")
                    .foregroundStyle(tokens.accentTx)
            } else {
                Button("Make default") { Task { await store.setDefault(key: row.key) } }
                    .disabled(!row.canMakeDefault || busy)
            }
        } footer: {
            if !row.canMakeDefault, let hint = row.defaultHint { Text(hint) }
        }

        Section {
            NavigationLink("Edit name, description, context") {
                ModelsEditForm(store: store, row: row)
            }
        }
    }
}

/// Edit the three overrides. Fields are prefilled from the box's `editable`
/// values and sent as typed; the box keeps only what differs from the provider's
/// default, and clearing every field removes the override.
struct ModelsEditForm: View {
    @ObservedObject var store: ModelsStore
    let row: ModelsTableRowWire
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var description: String
    @State private var context: String

    init(store: ModelsStore, row: ModelsTableRowWire) {
        self.store = store
        self.row = row
        _name = State(initialValue: row.editable.name)
        _description = State(initialValue: row.editable.description)
        _context = State(initialValue: row.editable.context.map(String.init) ?? "")
    }

    var body: some View {
        Form {
            Section("Name") { TextField("Name", text: $name) }
            Section("Description") { TextField("Description", text: $description, axis: .vertical).lineLimit(1...4) }
            Section {
                TextField("Context size (tokens)", text: $context)
                    .keyboardType(.numberPad)
                if let error = store.fieldError, error.field == "context" {
                    Text(error.message).font(.footnote).foregroundStyle(.red)
                }
            } header: {
                Text("Context size")
            } footer: {
                Text("Leave a field blank to keep the provider's default for it.")
            }
            if let error = store.fieldError, error.field != "context" {
                Section { Text(error.message).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Edit \(row.name)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if store.busyKey == row.key {
                    ProgressView()
                } else {
                    Button("Save") {
                        Task {
                            if await store.saveOverride(key: row.key, name: name, description: description, context: context) {
                                dismiss()
                            }
                        }
                    }
                    .disabled(store.busyKey != nil)
                }
            }
        }
        .onAppear { store.clearFieldError() }
    }
}
