import Foundation

// ===========================================================================
// BET-1140 — deprecated-model opt-ins.
//
// A model the provider still serves but flags as deprecated is shown
// GREYED/DISABLED in the model list by default; the user explicitly opts it
// back in and that choice persists on-device, at which point it becomes a
// normal selectable row.
//
// The opt-in is a HABIT (which deprecated models this user will keep using),
// not tied to one conversation, so it persists PER BOX under a single
// UserDefaults key — the same storage idiom as ModelRecents. Keys are
// "providerID/modelID". One predicate (`ChatModel.isDeprecated`) and one
// storage idiom; nothing here diverges from the desktop (BET-1139).
// ===========================================================================

enum DeprecatedModelOptIns {
    /// Per-box storage key (an opt-in is not tied to one session).
    static let storageKey = "manta:deprecated-model-opt-ins"

    static func load(_ defaults: UserDefaults = .standard) -> Set<String> {
        guard let data = defaults.data(forKey: storageKey),
              let set = try? JSONDecoder().decode(Set<String>.self, from: data)
        else { return [] }
        return set
    }

    static func save(_ set: Set<String>, _ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(set) {
            defaults.set(data, forKey: storageKey)
        }
    }
}
