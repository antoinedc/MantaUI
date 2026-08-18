import Foundation

// ===========================================================================
// S5 — model picker pure logic (BET-597).
//
// The composer's model pill + menu. All decision logic is pure and tests
// against `OpencodeModel[]` / `OpencodeModelID` values (box-side `opencode:models`
// + `opencode:default-model`). The per-session override is an opaque
// `providerID/modelID` string in UserDefaults (not a credential); the raw
// string form travels between this module and the user-defaults-backed store.
//
// Behavioural reference: the desktop `ModelPicker.tsx` — per-session override
// with the configured default as fallback. No design values invented here.
// ===========================================================================

enum ChatModel {

    // MARK: - Fast-mode sibling models (desktop ⚡ toggle port)

    /// Several providers ship a "fast" flavour of a model as a SEPARATE model id
    /// with a `-fast` suffix rather than as a variant (`gpt-5.6` / `gpt-5.6-fast`).
    /// The picker treats fast as a MODE of the base model: the `-fast` id is
    /// hidden from the dropdown (as long as its base twin is also visible) and
    /// reached instead through the fast-mode toggle. Mirrors the desktop's
    /// `isFastModelId` / `baseModelId` / `fastModelId` / `resolveFastToggle`.
    static let fastSuffix = "-fast"

    /// True when `modelID` is the fast flavour of some base model.
    static func isFastModelID(_ modelID: String) -> Bool {
        modelID.count > fastSuffix.count && modelID.hasSuffix(fastSuffix)
    }

    /// `"gpt-5.6-fast"` → `"gpt-5.6"`; a non-fast id is returned unchanged.
    static func baseModelID(_ modelID: String) -> String {
        isFastModelID(modelID) ? String(modelID.dropLast(fastSuffix.count)) : modelID
    }

    /// `"gpt-5.6"` → `"gpt-5.6-fast"`; a fast id is returned unchanged.
    static func fastModelID(_ modelID: String) -> String {
        isFastModelID(modelID) ? modelID : "\(modelID)\(fastSuffix)"
    }

    /// The ⚡ fast-mode toggle state for the active model. Available only when
    /// the counterpart model exists AND still offers the currently-selected
    /// effort/variant — flipping to fast must never silently drop the effort.
    /// With no variant selected, only the counterpart's existence matters.
    /// Mirrors the desktop `resolveFastToggle`.
    struct FastToggle {
        /// The toggle can be clicked (a counterpart exists that keeps the effort).
        let available: Bool
        /// The active model IS the fast flavour.
        let on: Bool
        /// The model a click switches to; nil when unavailable.
        let target: (providerID: String, modelID: String)?
        /// Human copy explaining the current state.
        let title: String
    }

    static func fastToggle(models: [OpencodeModel], active: OpencodeModel?, variantId: String?) -> FastToggle {
        let off = FastToggle(available: false, on: false, target: nil, title: "No fast mode for this model")
        guard let active else { return off }
        let isFast = isFastModelID(active.id)
        let counterpartID = isFast ? baseModelID(active.id) : fastModelID(active.id)
        let counterpart = models.first {
            $0.providerID == active.providerID &&
            $0.id == counterpartID &&
            $0.enabled != false &&
            $0.status?.lowercased() != "deprecated"
        }
        guard let counterpart else {
            if isFast {
                return FastToggle(available: false, on: true, target: nil, title: "Fast mode on (no standard model available)")
            }
            return off
        }
        let keepsVariant = variantId == nil || (counterpart.variants?.contains { $0.id == variantId } == true)
        guard keepsVariant else {
            return FastToggle(available: false, on: isFast, target: nil, title: "No fast mode at \(variantId ?? "") effort")
        }
        return FastToggle(
            available: true,
            on: isFast,
            target: (active.providerID, counterpartID),
            title: isFast
                ? "You're in fast mode — tap to switch to the standard model"
                : "Run this model in fast mode"
        )
    }

    // MARK: - Plan-mode toggle (desktop `resolvePlanToggle` port)

    /// The plan-mode toggle state (BET-952). Plan mode is a per-turn decision,
    /// not a model property, so availability is purely "does this box expose a
    /// `plan` primary agent". Mirrors the desktop `resolvePlanToggle` three
    /// states; `agent` is the resolved agent name to send on `opencode:prompt`.
    struct PlanToggle {
        /// The toggle can be clicked (a `plan` agent exists on the box).
        let available: Bool
        /// Plan mode is ON (persisted per session).
        let on: Bool
        /// True while the agents list hasn't arrived yet (the chip is a loading
        /// placeholder). Omitted (false) in the resolved states, mirroring TS.
        let loading: Bool
        /// The resolved agent name to send, nil when unavailable.
        let agent: String?
        /// Human copy explaining the current state.
        let title: String
    }

    /// Resolve the plan toggle for the box's agent list. `nil` agents = still
    /// loading. An explicit `on:true, available:false` (a plan agent vanished
    /// mid-toggle) stays LIT — a control that flips itself to "off" lies.
    /// Titles are byte-identical to the TS `resolvePlanToggle`.
    static func planToggle(agents: [OpencodeAgent]?, on: Bool) -> PlanToggle {
        guard let agents else {
            return PlanToggle(available: false, on: on, loading: true, agent: nil, title: "Loading agents…")
        }
        let plan = agents.first { $0.name == "plan" && $0.mode != "subagent" }
        guard let plan else {
            return on
                ? PlanToggle(available: false, on: true, loading: false, agent: nil, title: "Plan mode on (plan agent unavailable)")
                : PlanToggle(available: false, on: false, loading: false, agent: nil, title: "This server has no plan agent")
        }
        return PlanToggle(
            available: true,
            on: on,
            loading: false,
            agent: plan.name,
            title: on
                ? "Plan mode on — edits blocked. Click to build."
                : "Plan mode off — click to plan without editing"
        )
    }

    // MARK: - Grouping & filtering (desktop `groups` + `filterModelGroups`)

    /// Group models by provider, providers ordered alphabetically (matching
    /// the desktop `groups`). Enabled-only, deprecated excluded, and `-fast`
    /// siblings dropped where their base twin survives (a fast flavour is a
    /// MODE of the base, reached through the ⚡ toggle — not a separate choice).
    /// Groups left empty are dropped so a list never renders a provider heading
    /// with nothing under it.
    static func groups(_ models: [OpencodeModel]) -> [(provider: String, models: [OpencodeModel])] {
        var map: [String: [OpencodeModel]] = [:]
        for m in models where isPickable(m) {
            map[m.providerID, default: []].append(m)
        }
        return map.keys.sorted().compactMap { provider in
            guard let all = map[provider] else { return nil }
            let ids = Set(all.map(\.id))
            let kept = all.filter { !(isFastModelID($0.id) && ids.contains(baseModelID($0.id))) }
            return kept.isEmpty ? nil : (provider, kept)
        }
    }

    /// Filter already-grouped models by a case-insensitive query against the
    /// model name, id, or provider. Empty/blank query returns everything.
    /// Mirrors the desktop `filterModelGroups`.
    static func filteredGroups(_ groups: [(provider: String, models: [OpencodeModel])], query: String) -> [(provider: String, models: [OpencodeModel])] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return groups }
        return groups.compactMap { group in
            let kept = group.models.filter {
                $0.name.lowercased().contains(q) ||
                $0.id.lowercased().contains(q) ||
                group.provider.lowercased().contains(q)
            }
            return kept.isEmpty ? nil : (group.provider, kept)
        }
    }

    /// A model is pickable when it is not explicitly disabled and not
    /// deprecated. Absent `enabled`/`status` (common) → pickable.
    static func isPickable(_ m: OpencodeModel) -> Bool {
        if m.enabled == false { return false }
        if m.status?.lowercased() == "deprecated" { return false }
        return true
    }

    /// The effective selection: override wins, else the configured default.
    static func effective(_ override: OpencodeModelID?, _ defaultModel: OpencodeModelID?) -> OpencodeModelID? {
        override ?? defaultModel
    }

    /// Resolve the active model object (for the pill's friendly name), or nil
    /// when neither an override nor the default names a known pickable model.
    static func activeModel(_ models: [OpencodeModel], override: OpencodeModelID?, default defaultModel: OpencodeModelID?) -> OpencodeModel? {
        guard let selection = effective(override, defaultModel) else { return nil }
        return models.first { $0.providerID == selection.providerID && $0.id == selection.modelID }
    }

    /// The pill's short label: the active model's friendly name, else
    /// "Default" when no effective selection resolves.
    static func label(_ models: [OpencodeModel], override: OpencodeModelID?, default defaultModel: OpencodeModelID?) -> String {
        if let active = activeModel(models, override: override, default: defaultModel) {
            return active.name
        }
        if override != nil || defaultModel != nil { return "Default" }
        return "Default"
    }

    /// Fuzzy-match a named model against the pickable list (desktop's
    /// `fuzzyMatchModel`-style resolution).
    static func findByQuery(_ models: [OpencodeModel], query: String) -> OpencodeModel? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return nil }
        for m in models where isPickable(m) {
            if m.id.lowercased() == q { return m }
            if m.name.lowercased() == q { return m }
        }
        for m in models where isPickable(m) {
            if m.id.lowercased().contains(q) || m.name.lowercased().contains(q) { return m }
        }
        return nil
    }

    // MARK: - Catalogue row badges (BET-825)

    /// Compact context-window display, ported from the desktop
    /// `formatModelContextSize` (src/renderer/chatUtils.ts): 200_000 → "200k",
    /// 1_000_000 → "1M", 1_500_000 → "1.5M". Returns nil for a missing /
    /// non-positive limit so callers omit the badge entirely rather than
    /// rendering "0k". At 1M+ it switches to millions and strips a trailing
    /// ".0"; below it keeps the k form.
    static func contextSize(_ context: Double?) -> String? {
        guard let context, context.isFinite, context > 0 else { return nil }
        if context >= 1_000_000 {
            let m = context / 1_000_000
            let rounded = (m * 10).rounded() / 10
            let text = String(format: "%.1f", rounded)
            let trimmed = text.hasSuffix(".0") ? String(text.dropLast(2)) : text
            return "\(trimmed)M"
        }
        return "\(Int((context / 1000).rounded()))k"
    }

    /// Display label for an effort variant id. A lookup, not a string
    /// transform: `.capitalized` renders the camel-cased level "xhigh" as
    /// "Xhigh". Unknown ids fall back to capitalisation so a provider that
    /// ships a new level still reads sensibly rather than disappearing.
    static func effortLabel(_ variantID: String) -> String {
        switch variantID.lowercased() {
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "xHigh"
        case "max": return "Max"
        default: return variantID.capitalized
        }
    }

    /// The vendor words the composer chip strips off a model's friendly name.
    /// PORTED VERBATIM from `MODEL_BRAND_PREFIXES` in
    /// `src/renderer/chatUtils.ts` — including the capitalisation, which is the
    /// desktop's match and is therefore ours. When that list changes, change it
    /// here; do not "improve" one side alone.
    static let modelBrandPrefixes: Set<String> = [
        "Claude", "Gemini", "DeepSeek", "Grok", "Mistral",
        "Llama", "Qwen", "Command", "Gemma", "Phi", "Gpt",
    ]

    /// Compact display name for the composer chip — the Swift twin of the
    /// desktop's `shortModelName`. The name opencode returns is usually
    /// "<brand> <family> <version>" ("Claude Opus 5"); the chip shows the family
    /// and version only ("Opus 5"), leaving the effort run beside it as the only
    /// other token. An unknown prefix falls through unchanged, so no name is ever
    /// mangled — and a name that is nothing BUT a brand word is returned whole
    /// rather than emptied.
    static func shortName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let space = trimmed.firstIndex(of: " ") else { return trimmed }
        guard modelBrandPrefixes.contains(String(trimmed[trimmed.startIndex..<space])) else {
            return trimmed
        }
        let rest = trimmed[trimmed.index(after: space)...]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return rest.isEmpty ? trimmed : rest
    }

    /// Capability glyphs for a catalogue row, in display order: "reasoning"
    /// when the model reasons, "vision" when it accepts image input. Both read
    /// the box's own capability flags rather than being inferred — a model can
    /// reason without exposing an effort dial, so deriving "reasoning" from the
    /// presence of variants mislabels it.
    ///
    /// The predicates are the two private helpers BELOW (`reasoningCapability` /
    /// `visionCapability`), which share a single definition each with the
    /// catalogue's capability filter (`matches(_:filter:in:)`). If the filter
    /// and the badge ever disagreed, a row would show a glyph yet vanish under
    /// the matching chip — the exact failure BET-895 exists to prevent.
    static func capabilityGlyphs(_ model: OpencodeModel) -> [String] {
        var glyphs: [String] = []
        if reasoningCapability(model) { glyphs.append("reasoning") }
        if visionCapability(model) { glyphs.append("vision") }
        return glyphs
    }

    /// The one "does this model reason" notion — shared by the reasoning badge
    /// and the Reasoning filter. Reads the box's own `capabilities.reasoning`
    /// flag (BET-825), never inferred from the presence of variants.
    private static func reasoningCapability(_ model: OpencodeModel) -> Bool {
        model.capabilities?.reasoning == true
    }

    /// The one "does this model accept images" notion — shared by the vision
    /// badge and the Vision filter. Reads the box's own `input.image` flag.
    private static func visionCapability(_ model: OpencodeModel) -> Bool {
        model.capabilities?.input?.image == true
    }

    /// The catalogue's capability filter. `all` is the identity filter and is
    /// the default; the other three narrow by a property the model itself
    /// declares, so a provider that annotates nothing simply never matches.
    enum ModelCapabilityFilter: String, CaseIterable, Sendable {
        case all, reasoning, vision, fast

        /// The chip's label — "All", "Reasoning", "Vision", "Fast".
        var title: String {
            switch self {
            case .all: return "All"
            case .reasoning: return "Reasoning"
            case .vision: return "Vision"
            case .fast: return "Fast"
            }
        }
    }

    /// Whether `model` satisfies `filter`. `all` matches everything (the
    /// identity filter). `reasoning`/`vision` share their predicate with
    /// `capabilityGlyphs`, so a filter never disagrees with the badge it
    /// narrows. `fast` needs the whole `models` list because a fast twin is a
    /// SEPARATE model id (`<id>-fast`), not a flag on the model.
    static func matches(_ model: OpencodeModel,
                        filter: ModelCapabilityFilter,
                        in models: [OpencodeModel]) -> Bool {
        switch filter {
        case .all:
            return true
        case .reasoning:
            return reasoningCapability(model)
        case .vision:
            return visionCapability(model)
        case .fast:
            return models.contains {
                $0.providerID == model.providerID
                    && $0.id == fastModelID(model.id)
                    && isPickable($0)
            }
        }
    }

    // MARK: - Cockpit + catalogue copy (BET-894)

    /// The catalogue row's badge line: context size, then capability glyphs —
    /// "1M · reasoning · vision". Any absent part is omitted, never rendered
    /// empty. Moved verbatim from the old `ModelPickerSheet.badgeText` so the
    /// string lives in the pure layer, not a view.
    static func catalogueBadge(_ m: OpencodeModel) -> String {
        var parts: [String] = []
        if let ctx = contextSize(m.limit?.context) {
            parts.append(ctx)
        }
        parts.append(contentsOf: capabilityGlyphs(m))
        return parts.joined(separator: " · ")
    }

    /// The cockpit card's subtitle: provider, then "<context> context" when the
    /// limit is known, then the capability glyphs — "anthropic · 1M context ·
    /// reasoning". Any absent part is omitted, never rendered empty; a missing
    /// limit must not leave a stray " · ".
    static func cardSubtitle(_ m: OpencodeModel) -> String {
        var parts = [m.providerID]
        if let ctx = contextSize(m.limit?.context) {
            parts.append("\(ctx) context")
        }
        parts.append(contentsOf: capabilityGlyphs(m))
        return parts.joined(separator: " · ")
    }

    /// How many models the catalogue will actually show in its "All models · N"
    /// count — the total across `groups(_:)`, so the count can never disagree
    /// with the list beneath it (which likewise excludes disabled/deprecated
    /// models and `-fast` twins whose base twin survives).
    static func pickableCount(_ models: [OpencodeModel]) -> Int {
        groups(models).reduce(0) { $0 + $1.models.count }
    }

    /// Encode a selection as the persisted `providerID/modelID` string.
    static func encode(_ id: OpencodeModelID) -> String {
        "\(id.providerID)/\(id.modelID)"
    }

    /// Decode a persisted override string, or nil when malformed/empty.
    static func decode(_ raw: String) -> OpencodeModelID? {
        let parts = raw.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return OpencodeModelID(providerID: parts[0], modelID: parts[1])
    }
}
