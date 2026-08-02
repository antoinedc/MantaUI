import SwiftUI

// ===========================================================================
// Model + effort selection.
//
// These are TWO independent choices and are presented as such: which model
// answers, and how much reasoning effort it spends. Effort is model-specific
// (opencode exposes it as a model's "variants"), so the effort list is derived
// from the chosen model and is simply absent for a model that offers none —
// rather than being a fixed set of levels that silently do nothing.
//
// Stock components on purpose: a Form with two navigation-link Pickers is the
// system's own shape for this, complete with checkmarks, grouped sections,
// search-free scrolling of a long provider list, dynamic type and VoiceOver.
// The menu it replaces put every provider, model and level in one long popup.
// ===========================================================================

struct ModelPickerSheet: View {
    @ObservedObject var modelStore: ChatModelStore
    @Environment(\.dismiss) private var dismiss

    /// `nil` = follow the box's configured default.
    private var modelSelection: Binding<OpencodeModelID?> {
        Binding(
            get: { modelStore.override },
            set: { modelStore.setOverride($0) }
        )
    }

    private var variantSelection: Binding<String?> {
        Binding(
            get: { modelStore.variant },
            set: { modelStore.setVariant($0) }
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Model", selection: modelSelection) {
                        Text("Default").tag(OpencodeModelID?.none)
                        ForEach(ChatModel.groups(modelStore.models), id: \.provider) { group in
                            Section(group.provider) {
                                ForEach(group.models, id: \.id) { model in
                                    Text(model.name)
                                        .tag(Optional(OpencodeModelID(providerID: model.providerID, modelID: model.id)))
                                }
                            }
                        }
                    }
                    .pickerStyle(.navigationLink)
                } footer: {
                    Text(modelFooter)
                }

                Section {
                    if modelStore.activeVariants.isEmpty {
                        LabeledContent("Effort") {
                            Text("Not available")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Picker("Effort", selection: variantSelection) {
                            Text("Default").tag(String?.none)
                            ForEach(modelStore.activeVariants, id: \.id) { variant in
                                Text(variant.id.capitalized).tag(Optional(variant.id))
                            }
                        }
                        .pickerStyle(.navigationLink)
                    }
                } footer: {
                    Text(effortFooter)
                }
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear { modelStore.load() }
    }

    private var modelFooter: String {
        modelStore.override == nil
            ? "Using the model your box is configured to use."
            : "This choice applies to this session only."
    }

    private var effortFooter: String {
        modelStore.activeVariants.isEmpty
            ? "This model has no effort setting."
            : "More effort means more reasoning time before it answers."
    }
}
