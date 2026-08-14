import SwiftUI

// ===========================================================================
// Model picker — the COCKPIT sheet (proposal A, BET-894).
//
// The front door is a sheet (the "cockpit"), reached by tapping the composer's
// model chip: the active model as a card with its effort + fast controls inside
// it, a recents row, and the single route to the full catalogue ("All models").
// The catalogue is a PUSHED second tier (`ModelCatalogueView`), not a detent.
//
// Why not a `Menu` (the old proposal B)? A SwiftUI `Menu` renders as a UIKit
// menu, and a UIKit menu's contents can only be buttons, toggles, submenus and
// dividers — it cannot host arbitrary layout. So the "inline segmented effort
// control" and the recents/capability chips the menu attempted are silently
// dropped or degraded to a plain option list at runtime. The sheet is the one
// surface that can render the agreed design. Do not revert to a menu: the
// segmented picker and the card layout only survive as the sheet's.
//
// Every visual decision is the spec in BET-894; nothing is invented here.
// Text uses `Font.manta(size:weight:)` (Dynamic Type scales reading text);
// chrome glyphs use `.system(size:)`. `UsageSheets.swift` is the house
// reference for sheet chrome, card containers and action rows.
// ===========================================================================

/// The cockpit sheet — the model picker's front door. Medium detent at rest;
/// grows to large only when the catalogue is pushed. Dragging between detents
/// changes nothing about the content.
struct ModelPickerSheet: View {
    @ObservedObject var modelStore: ChatModelStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var detent: PresentationDetent = .medium
    @State private var showCatalogue = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    private var activeModel: OpencodeModel? {
        ChatModel.activeModel(modelStore.models, override: modelStore.override, default: modelStore.defaultModel)
    }

    private var fastToggleState: ChatModel.FastToggle {
        ChatModel.fastToggle(models: modelStore.models, active: activeModel, variantId: modelStore.variant)
    }

    private var showFastToggle: Bool {
        let fast = fastToggleState
        return fast.available || fast.on
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if modelStore.loaded {
                    cockpit
                } else {
                    // Box-wide model list still arriving — an explicit loading
                    // state rather than an empty sheet.
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
            .navigationDestination(isPresented: $showCatalogue) {
                ModelCatalogueView(modelStore: modelStore, onPick: { dismiss() })
            }
        }
        // Medium shows the cockpit; pushing the catalogue grows the sheet to
        // large, and popping returns it to medium. Dragging medium↔large by
        // hand changes nothing about the content.
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .onChange(of: showCatalogue) { _, isPresented in
            detent = isPresented ? .large : .medium
        }
        .onAppear { modelStore.load() }
    }

    /// Top to bottom: the active-model card, the recents chips, and the only
    /// route to the catalogue.
    private var cockpit: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            activeModelCard
            if showRecents {
                recentsBlock
            }
            allModelsRow
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp4)
        .accessibilityIdentifier("model-cockpit")
    }

    // MARK: - Active-model card

    /// One container holding the model + its effort + its fast flag, because
    /// effort is a property OF the selected model and must read as attached to
    /// it. Same recipe as `UsageWindowRow` (UsageSheets.swift).
    private var activeModelCard: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            identityRow
            if !modelStore.activeVariants.isEmpty {
                effortControl
            }
            if showFastToggle {
                fastToggle
            }
        }
        .padding(Metrics.spacing.sp3)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.radius.lg)
                .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
        )
    }

    private var identityRow: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            Image(systemName: "sparkles")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(tokens.accentTx)
                .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                .background(tokens.accentSoft, in: RoundedRectangle(cornerRadius: Metrics.radius.md))
            VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                Text(activeModelName)
                    .font(.manta(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                    .lineLimit(1)
                Text(activeModelSubtitle)
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }

    private var activeModelName: String {
        activeModel?.name ?? "Server default"
    }

    private var activeModelSubtitle: String {
        guard let model = activeModel else {
            return "Using the model your box is configured to use."
        }
        return ChatModel.cardSubtitle(model)
    }

    /// The "Reasoning effort" label above the segmented picker.
    private var effortLabel: some View {
        Text("Reasoning effort")
            .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
            .foregroundColor(tokens.tx3)
    }

    /// Segmented effort control, moved from the old composer menu. The
    /// "Default" segment is the model's own recommended level (no explicit
    /// variant); a `Menu` could not render this as a strip, the sheet can.
    private var effortControl: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            effortLabel
            Picker("Reasoning effort", selection: Binding<String>(
                get: { modelStore.variant ?? "" },
                set: { newValue in
                    modelStore.setVariant(newValue.isEmpty ? nil : newValue)
                    modelStore.recordCurrentChoice()
                }
            )) {
                Text("Default").tag("")
                ForEach(modelStore.activeVariants, id: \.id) { variant in
                    Text(ChatModel.effortLabel(variant.id)).tag(variant.id)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    /// Fast-mode toggle — a session-level flag, so it sits at the same level
    /// as effort, never nested under it. Omitted when the model has no fast
    /// twin. Moved from the old composer menu verbatim.
    private var fastToggle: some View {
        let fast = fastToggleState
        return Toggle(isOn: Binding(
            get: { fast.on },
            set: { on in
                modelStore.setFast(on)
                modelStore.recordCurrentChoice()
            }
        )) {
            VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                Label("Fast mode", systemImage: fast.on ? "bolt.fill" : "bolt")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                Text("lower latency twin")
                    .font(.manta(size: Metrics.type.twoXS))
                    .foregroundColor(tokens.tx4)
            }
        }
        .disabled(!fast.available)
        .tint(tokens.accentSolid)
    }

    // MARK: - Recents

    /// Show the block unless the only chip it would render is an unselected
    /// "Server default" — i.e. no recents AND an override is set.
    private var showRecents: Bool {
        !modelStore.recents.isEmpty || modelStore.override == nil
    }

    private var recentsBlock: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            Text("Recent")
                .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
                .foregroundColor(tokens.tx3)
            WrapLayout(spacing: Metrics.spacing.sp2) {
                ForEach(modelStore.recents, id: \.self) { choice in
                    ModelChip(
                        title: ModelRecents.label(for: choice, models: modelStore.models),
                        selected: modelStore.activeChoice == choice,
                        tokens: tokens
                    ) {
                        modelStore.apply(choice)
                        dismiss()
                    }
                }
                ModelChip(
                    title: "Server default",
                    selected: modelStore.override == nil,
                    tokens: tokens,
                    accessibilityIdentifier: "model-server-default"
                ) {
                    modelStore.setOverride(nil)
                    dismiss()
                }
            }
        }
    }

    // MARK: - All-models row

    /// The only route to the catalogue. Mirrors `ContextSheet`'s action-row
    /// recipe (UsageSheets.swift): accent glyph, title, spacer, count, chevron.
    private var allModelsRow: some View {
        Button { showCatalogue = true } label: {
            HStack(spacing: Metrics.spacing.sp2) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.accentTx)
                Text("All models")
                    .font(.manta(size: Metrics.type.small, weight: .semibold))
                    .foregroundColor(tokens.tx1)
                Spacer(minLength: 0)
                Text("\(ChatModel.pickableCount(modelStore.models))")
                    .font(.manta(size: Metrics.type.small))
                    .foregroundColor(tokens.tx4)
                Image(systemName: "chevron.right")
                    .font(.system(size: Metrics.type.xs))
                    .foregroundColor(tokens.tx4)
            }
            .padding(Metrics.spacing.sp3)
            .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radius.lg)
                    .stroke(tokens.borderSubtle, lineWidth: Metrics.spacing.spPx)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("model-all-models")
    }
}

// MARK: - The catalogue (pushed tier)

/// The long-tail model list, pushed from the cockpit's "All models" row. This
/// is today's whole sheet body, moved: searchable grouped list, rows with a
/// context/capability badge. The "Server default" + recents sections moved OUT
/// to the cockpit — nothing is pickable in two places any more.
struct ModelCatalogueView: View {
    @ObservedObject var modelStore: ChatModelStore
    /// Called when a model is picked so the whole sheet dismisses — one hop
    /// back to the conversation, not back to the cockpit.
    let onPick: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var query = ""
    /// The active capability filter. View state only — resets to `.all` every
    /// time the catalogue is opened; it is a lookup aid, not a preference.
    @State private var filter: ChatModel.ModelCapabilityFilter = .all

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    /// One pipeline, one place: capability filter → group → query. The filter
    /// runs over the full model list first (a `fast` twin must be found in the
    /// WHOLE list, including a model the filter would otherwise drop), then
    /// `groups`/`filteredGroups` handle the pickable grouping and the search.
    private var groups: [(provider: String, models: [OpencodeModel])] {
        let all = modelStore.models
        let filtered = all.filter { ChatModel.matches($0, filter: filter, in: all) }
        return ChatModel.filteredGroups(ChatModel.groups(filtered), query: query)
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

    var body: some View {
        Group {
            if modelStore.loaded {
                List {
                    capabilityFilterSection
                    providerSections
                }
                .searchable(
                    text: $query,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search \(ChatModel.pickableCount(modelStore.models)) models"
                )
            } else {
                ProgressView("Loading models…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("All models")
        .navigationBarTitleDisplayMode(.inline)
        // Pushed view: no Done button, no detents — those belong to the sheet root.
    }

    /// The catalogue's capability filter row: "All · Reasoning · Vision ·
    /// Fast", exactly one active at a time (`.all` on entry). A plain
    /// `HStack` — the four short chips fit one line, so this neither wraps nor
    /// scrolls. It is the `List`'s first `Section` with no header, so it
    /// scrolls with the content rather than pinning, and its row insets match
    /// the model rows around it.
    private var capabilityFilterSection: some View {
        Section {
            HStack(spacing: Metrics.spacing.sp2) {
                ForEach(ChatModel.ModelCapabilityFilter.allCases, id: \.self) { f in
                    ModelChip(
                        title: f.title,
                        selected: filter == f,
                        tokens: tokens,
                        accessibilityIdentifier: "model-filter-\(f.rawValue)"
                    ) {
                        filter = f
                    }
                }
            }
            .padding(.vertical, Metrics.spacing.sp1)
        }
    }

    /// The model list, grouped into a Section per provider. Empty-query misses
    /// AND a capability filter with no matches both render the platform search
    /// empty state — a user who filters to Vision on a box with no vision model
    /// gets the platform state, not a blank list.
    @ViewBuilder
    private var providerSections: some View {
        if groups.isEmpty {
            ContentUnavailableView.search(text: "No models match")
        } else {
            ForEach(groups, id: \.provider) { group in
                Section {
                    ForEach(group.models, id: \.id) { m in
                        Button { select(m); onPick() } label: {
                            HStack(alignment: .center, spacing: Metrics.spacing.sp2) {
                                VStack(alignment: .leading, spacing: Metrics.spacing.spPx) {
                                    Text(m.name)
                                        .lineLimit(1)
                                    let badge = ChatModel.catalogueBadge(m)
                                    if !badge.isEmpty {
                                        Text(badge)
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

    private var checkmark: some View {
        Image(systemName: "checkmark")
            .font(.system(size: Metrics.type.small, weight: .semibold))
            .foregroundStyle(.tint)
    }
}

// MARK: - Reusable chip + wrap primitive

/// A selectable pill chip used by every chip on the picker screen (recents, and
/// the next issue's filter row). Styling reuses the composer chip's own padding
/// + fill vocabulary.
struct ModelChip: View {
    let title: String
    let selected: Bool
    let tokens: Tokens
    var accessibilityIdentifier: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.manta(size: Metrics.type.small, weight: selected ? .semibold : .regular))
                .lineLimit(1)
                .padding(.vertical, Metrics.spacing.sp1)
                .padding(.horizontal, Metrics.spacing.sp2)
                .background(selected ? tokens.accentSoft : tokens.fill, in: Capsule())
                .foregroundColor(selected ? tokens.accentTx : tokens.tx2)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityIdentifier ?? "")
    }
}

/// Left-aligned wrapping row — the recents chips are variable-width and must
/// wrap, which no stock stack does. Kept private to the picker; if a second
/// caller appears, move it, don't copy it.
struct WrapLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.replacingUnspecifiedDimensions().width
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
        return CGSize(width: maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxWidth = bounds.width
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }
}
