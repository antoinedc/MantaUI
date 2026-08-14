import Foundation

// ===========================================================================
// BET-825 — the composer model menu's recents: the last 3–5 (model, effort,
// fast) triples actually used, most recent first.
//
// Recents are a HABIT, not a conversation, so they persist PER BOX under a
// single UserDefaults key — deliberately NOT per session, unlike the model
// override/variant (which live in ChatModelStore under per-session keys). The
// store loads them once at init and writes them on every change.
//
// `modelID` in a choice is ALWAYS the base (non-`-fast`) id: fast is an
// orthogonal mode bit, not a separate model, so the same model at the same
// effort with fast off/on is a distinct entry. Dedup/ordering/cap logic is
// pure (mirrors `BranchFreshnessPolicy` in ChatScreen.swift); persistence is a
// thin pair of helpers beside it.
// ===========================================================================

/// One remembered (model, effort, fast) selection, most recent first.
struct ModelChoice: Codable, Hashable, Sendable {
    let providerID: String
    /// The BASE model id — never a `-fast` flavour (fast is the `fast` flag).
    let modelID: String
    /// The reasoning-effort variant id, or nil (the model's recommended default).
    let variant: String?
    /// Whether the fast twin of `modelID` is used.
    let fast: Bool
}

enum ModelRecents {
    /// The recents list is capped at this many entries.
    static let capacity = 5
    /// Per-box storage key (recents are a habit, not tied to one session).
    static let storageKey = "manta:model-recents"

    /// Insert a choice at the front, de-duplicating on the WHOLE triple. A
    /// choice already in the list is moved to the front without duplicating;
    /// the same model at a different effort (or fast state) is distinct. The
    /// list never grows past `capacity` — the oldest entry drops off.
    static func record(_ choice: ModelChoice, into list: [ModelChoice]) -> [ModelChoice] {
        var out = list.filter { $0 != choice }
        out.insert(choice, at: 0)
        return Array(out.prefix(capacity))
    }

    /// The display label for a stored choice: "Opus 4.7 · High" with a bolt
    /// appended when fast is on. Resolves the friendly name from the model
    /// list, falling back to the model id when the list doesn't name it.
    static func label(for choice: ModelChoice, models: [OpencodeModel]) -> String {
        let name = models.first {
            $0.providerID == choice.providerID && ChatModel.baseModelID($0.id) == choice.modelID
        }?.name ?? choice.modelID
        var parts = [name]
        if let variant = choice.variant, !variant.isEmpty {
            parts.append(variant.capitalized)
        }
        if choice.fast { parts.append("⚡") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Persistence (per box)

    static func load(_ defaults: UserDefaults = .standard) -> [ModelChoice] {
        guard let data = defaults.data(forKey: storageKey),
              let list = try? JSONDecoder().decode([ModelChoice].self, from: data)
        else { return [] }
        return list
    }

    static func save(_ list: [ModelChoice], _ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(list) {
            defaults.set(data, forKey: storageKey)
        }
    }
}
