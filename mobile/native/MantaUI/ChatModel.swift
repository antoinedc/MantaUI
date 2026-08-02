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

    /// Group models by provider, providers ordered alphabetically (matching
    /// the desktop `groups`). Enabled-only, deprecated excluded.
    static func groups(_ models: [OpencodeModel]) -> [(provider: String, models: [OpencodeModel])] {
        var map: [String: [OpencodeModel]] = [:]
        for m in models where isPickable(m) {
            map[m.providerID, default: []].append(m)
        }
        return map.keys.sorted().compactMap { provider in
            map[provider].map { (provider, $0) }
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
