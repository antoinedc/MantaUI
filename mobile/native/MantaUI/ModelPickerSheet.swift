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
// Presented as ONE small sheet with two wheels side by side — model on the
// left, effort on the right — so both choices are visible and adjustable
// without navigating away. The effort wheel repopulates from whatever the
// highlighted model offers, and reads "Not available" for a model with none.
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
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    modelWheel
                    effortWheel
                }
                .frame(maxWidth: .infinity)

                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                    .padding(.bottom, 12)
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.height(320)])
        .presentationDragIndicator(.visible)
        .onAppear { modelStore.load() }
    }

    private var modelWheel: some View {
        VStack(spacing: 2) {
            Text("Model")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("Model", selection: modelSelection) {
                Text("Default").tag(OpencodeModelID?.none)
                ForEach(ChatModel.groups(modelStore.models), id: \.provider) { group in
                    ForEach(group.models, id: \.id) { model in
                        Text(model.name)
                            .tag(Optional(OpencodeModelID(providerID: model.providerID, modelID: model.id)))
                    }
                }
            }
            .pickerStyle(.wheel)
            .labelsHidden()
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var effortWheel: some View {
        VStack(spacing: 2) {
            Text("Effort")
                .font(.caption)
                .foregroundStyle(.secondary)
            if modelStore.activeVariants.isEmpty {
                Text("Not available")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .frame(maxHeight: .infinity)
            } else {
                Picker("Effort", selection: variantSelection) {
                    Text("Default").tag(String?.none)
                    ForEach(modelStore.activeVariants, id: \.id) { variant in
                        Text(variant.id.capitalized).tag(Optional(variant.id))
                    }
                }
                .pickerStyle(.wheel)
                .labelsHidden()
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var footer: String {
        if modelStore.override == nil {
            return "Using the model your box is configured to use."
        }
        return modelStore.activeVariants.isEmpty
            ? "This model has no effort setting. Applies to this session only."
            : "More effort means more reasoning time. Applies to this session only."
    }
}
