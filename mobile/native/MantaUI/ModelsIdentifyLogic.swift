import Foundation

// ===========================================================================
// WS09 F4 — the identify editor's pure UI affordances (M12, KEEP-CLIENT): the
// catalogue typeahead and the Save gate. The rows, help lines and the
// declaration itself are the box's (`models:unidentified` / `models:declare`).
// ===========================================================================

enum ModelsIdentifySearch {
    /// Top entries shown with an empty query / the cap for a typed one.
    static let emptyLimit = 30
    static let queryLimit = 50

    /// Empty query → the first 30 entries; otherwise a case-insensitive substring
    /// match over id / name / family, capped at 50.
    static func filter(entries: [ModelsCatalogEntryWire], query: String) -> [ModelsCatalogEntryWire] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return Array(entries.prefix(emptyLimit)) }
        let hits = entries.filter { e in
            "\(e.id) \(e.name ?? "") \(e.family ?? "")".lowercased().contains(q)
        }
        return Array(hits.prefix(queryLimit))
    }

    /// Save is enabled once a model is picked AND the price is answered: Free, or
    /// Custom with at least one finite rate. Caching defaults to None, so it never gates.
    static func canSave(selected: ModelsCatalogEntryWire?, priceMode: String?, costIn: String, costOut: String) -> Bool {
        guard selected != nil else { return false }
        switch priceMode {
        case "free": return true
        case "custom": return isFiniteNumber(costIn) || isFiniteNumber(costOut)
        default: return false
        }
    }

    private static func isFiniteNumber(_ s: String) -> Bool {
        guard let v = Double(s.trimmingCharacters(in: .whitespaces)) else { return false }
        return v.isFinite
    }
}
