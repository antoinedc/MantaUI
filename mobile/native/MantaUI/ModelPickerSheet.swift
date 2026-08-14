import SwiftUI

// ===========================================================================
// Tier 2 — the model CATALOGUE (BET-825).
//
// Reached ONLY from the composer chip's menu → "More Models…". This is the
// escape hatch for the long tail (searchable grouped list), not the front door
// — the common case lives in the menu (recents + inline effort + fast).
//
// The sheet opens at medium (recents + search visible) and drags to large to
// reveal the full grouped catalogue. Effort and Fast mode are GONE from here:
// they moved to the menu (Tier 1), so a decision is never set in two places.
// The effort/fast sections this sheet used to own were the duplicate code
// path this work exists to remove.
//
// Each row carries its context size + capability glyphs ("1M · reasoning ·
// vision") — at this scale the differentiator is capability, not name. The k/M
// badge comes from the shared `ChatModel.contextSize` (a port of the desktop's
// `formatModelContextSize`), never re-derived inline.
// ===========================================================================

struct ModelPickerSheet: View {
    @ObservedObject var modelStore: ChatModelStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var query = ""

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var groups: [(provider: String, models: [OpencodeModel])] {
        ChatModel.filteredGroups(ChatModel.groups(modelStore.models), query: query)
    }

    private func isSelected(_ m: OpencodeModel) -> Bool {
        guard let override = modelStore.override else { return false }
        return override.providerID == m.providerID && override.modelID == m.id
    }

    /// Pick a model from the catalogue and record it as a recently-used triple.
    private func select(_ m: OpencodeModel) {
        modelStore.setOverride(OpencodeModelID(providerID: m.providerID, modelID: m.id))
        modelStore.recordCurrentChoice()
    }

    /// The row's badge line: context size, then capability glyphs.
    private func badgeText(_ m: OpencodeModel) -> String {
        var parts: [String] = []
        if let ctx = ChatModel.contextSize(m.limit?.context) {
            parts.append(ctx)
        }
        parts.append(contentsOf: ChatModel.capabilityGlyphs(m))
        return parts.joined(separator: " · ")
    }

    var body: some View {
        NavigationStack {
            Group {
                if modelStore.loaded {
                    List {
                        serverDefaultSection
                        if !modelStore.recents.isEmpty {
                            recentsSection
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
            .navigationTitle("All models")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // Medium shows the recents + search; dragging up reveals the full
        // grouped catalogue. Not `.large`-only — that is the old full-height
        // sheet this replaces.
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { modelStore.load() }
    }

    /// The "Server default" row — pinned first, the effective model when no
    /// override is set.
    private var serverDefaultSection: some View {
        Section {
            Button { setOverrideAndDismiss(nil) } label: {
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

    /// The recently-used triples, most recent first — the habitual models the
    /// menu already surfaces, kept here so the medium detent of this sheet
    /// reads like the same habit.
    private var recentsSection: some View {
        Section("Recents") {
            ForEach(modelStore.recents, id: \.self) { choice in
                Button { applyAndDismiss(choice) } label: {
                    HStack {
                        Text(ModelRecents.label(for: choice, models: modelStore.models))
                            .lineLimit(1)
                        Spacer()
                        if modelStore.activeChoice == choice { checkmark }
                    }
                }
            }
        }
    }

    /// The model list, grouped into a Section per provider. Empty-query misses
    /// render the platform search empty state rather than ad-hoc text.
    @ViewBuilder
    private var providerSections: some View {
        if groups.isEmpty {
            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ContentUnavailableView.search(text: "No models match")
            }
        } else {
            ForEach(groups, id: \.provider) { group in
                Section {
                    ForEach(group.models, id: \.id) { m in
                        Button { select(m); dismiss() } label: {
                            HStack(alignment: .center, spacing: Metrics.spacing.sp2) {
                                VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                                    Text(m.name)
                                        .lineLimit(1)
                                    if !badgeText(m).isEmpty {
                                        Text(badgeText(m))
                                            .font(.manta(size: Metrics.type.xs))
                                            .foregroundColor(tokens.tx3)
                                    }
                                }
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

    private func setOverrideAndDismiss(_ id: OpencodeModelID?) {
        modelStore.setOverride(id)
        dismiss()
    }

    private func applyAndDismiss(_ choice: ModelChoice) {
        modelStore.apply(choice)
        dismiss()
    }

    private var checkmark: some View {
        Image(systemName: "checkmark")
            .font(.system(size: Metrics.type.small, weight: .semibold))
            .foregroundStyle(.tint)
    }
}
