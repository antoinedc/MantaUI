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
// Native iOS surface (HIG-aligned): a grouped Form/List in a sheet, ordered
//                                ...
//   - "Server default" row pinned first — the effective model when no per-
//     session override is set.
//   - A "Fast mode" Toggle, shown only when the active model has a fast twin
//     available (desktop ⚡ logic). Fast flavours (`<id>-fast`) are a MODE of
//     the base model, not a separate row, so they are hidden from the groups
//     and reached through this toggle.
//   - An "Effort" section listing the active model's variants (Default + each).
//   - The model list grouped into Section per provider (the desktop menu's
//     shape), with a search strip and a checkmark on the selected row.
//
// Tapping a model sets the per-session override; toggling Fast swaps the
// override to the model's `-fast` twin (or back), carrying the chosen effort.
// ===========================================================================

struct ModelPickerSheet: View {
    @ObservedObject var modelStore: ChatModelStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var groups: [(provider: String, models: [OpencodeModel])] {
        ChatModel.filteredGroups(ChatModel.groups(modelStore.models), query: query)
    }

    private var activeModel: OpencodeModel? {
        ChatModel.activeModel(modelStore.models, override: modelStore.override, default: modelStore.defaultModel)
    }

    /// The fast-mode toggle state for the active model (desktop `resolveFastToggle`).
    private var fast: ChatModel.FastToggle {
        ChatModel.fastToggle(models: modelStore.models, active: activeModel, variantId: modelStore.variant)
    }

    private func isSelected(_ m: OpencodeModel) -> Bool {
        guard let override = modelStore.override else { return false }
        return override.providerID == m.providerID && override.modelID == m.id
    }

    private func select(_ m: OpencodeModel) {
        modelStore.setOverride(OpencodeModelID(providerID: m.providerID, modelID: m.id))
    }

    /// Apply the fast-mode toggle: switch the override to the model's `-fast`
    /// twin (or its base), carrying the currently-chosen effort across.
    private func applyFastToggle(_ on: Bool) {
        guard let target = fast.target else { return }
        let currentVariant = modelStore.variant
        modelStore.setOverride(OpencodeModelID(providerID: target.providerID, modelID: target.modelID))
        if let currentVariant { modelStore.setVariant(currentVariant) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if modelStore.loaded {
                    List {
                        serverDefaultSection
                        if fast.available || fast.on {
                            fastSection
                        }
                        if !modelStore.activeVariants.isEmpty {
                            effortSection
                        }
                        providerSections
                    }
                    .searchable(
                        text: $query,
                        placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Search models"
                    )
                } else {
                    // Box-wide model list still arriving — an explicit loading
                    // state rather than an empty list.
                    ProgressView("Loading models…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onAppear { modelStore.load() }
    }

    /// The "Server default" row — the effective model when no override is set.
    private var serverDefaultSection: some View {
        Section {
            Button { modelStore.setOverride(nil) } label: {
                HStack {
                    Text("Server default")
                    Spacer()
                    if modelStore.override == nil { checkmark }
                }
            }
            .accessibilityIdentifier("model-server-default")
        } header: {
            Text("Model")
        } footer: {
            if modelStore.override == nil {
                Text("Using the model your box is configured to use.")
            }
        }
    }

    /// Fast-mode toggle, present only when it can do something.
    private var fastSection: some View {
        Section {
            Toggle(isOn: Binding(get: { fast.on }, set: { applyFastToggle($0) })) {
                Label("Fast mode", systemImage: fast.on ? "bolt.fill" : "bolt")
            }
            .disabled(!fast.available)
            .accessibilityIdentifier("model-fast-toggle")
        } footer: {
            Text(fast.title)
        }
    }

    /// Effort/variant list for the ACTIVE model. Absent when it offers none.
    private var effortSection: some View {
        Section("Effort") {
            Button { modelStore.setVariant(nil) } label: {
                HStack {
                    Text("Default")
                    Spacer()
                    if modelStore.variant == nil { checkmark }
                }
            }
            ForEach(modelStore.activeVariants, id: \.id) { variant in
                Button { modelStore.setVariant(variant.id) } label: {
                    HStack {
                        Text(variant.id.capitalized)
                        Spacer()
                        if modelStore.variant == variant.id { checkmark }
                    }
                }
            }
        }
    }

    /// The model list, grouped into a Section per provider.
    @ViewBuilder
    private var providerSections: some View {
        if groups.isEmpty {
            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Section {
                    Text("No models match")
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            ForEach(groups, id: \.provider) { group in
                Section {
                    ForEach(group.models, id: \.id) { m in
                        Button { select(m) } label: {
                            HStack {
                                Text(m.name)
                                Spacer()
                                if isSelected(m) { checkmark }
                            }
                        }
                    }
                } header: {
                    Text(group.provider)
                }
            }
        }
    }

    private var checkmark: some View {
        Image(systemName: "checkmark")
            .font(.system(size: Metrics.type.small, weight: .semibold))
            .foregroundStyle(.tint)
    }
}
