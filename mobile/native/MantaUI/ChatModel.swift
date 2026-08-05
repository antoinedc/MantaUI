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
        return FastToggle(
            available: keepsVariant,
            on: isFast,
            target: (active.providerID, counterpartID),
            title: isFast
                ? "You're in fast mode — tap to switch to the standard model"
                : keepsVariant ? "Run this model in fast mode" : "No fast mode at \(variantId ?? "") effort"
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

    /// Fuzzy-match a spoken/named model against the pickable list (desktop's
    /// `fuzzyMatchModel`-style resolution for the voice `model` action).
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
