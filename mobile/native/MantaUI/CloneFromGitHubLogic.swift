import Foundation

// ===========================================================================
// WS04 §6 — the clone flow's pure logic. Foundation-only (D19). Error words and the destination join are the box's.
// ===========================================================================

/// The words of a clone failure or a failed repository listing are the box's (WS11 D5 / S8): `forge:clone-status`
/// carries `errorKind` + `message`, `forge:repos` carries `message` + `needsSignIn`. Only the static fallbacks for an
/// older reply live here.
enum CloneFailureCopy {
    static let listFallback = "Couldn't list your repositories from GitHub."
    static let cloneFallback = "the clone failed."
}

enum ClonePicker {
    /// The owners to filter by, sorted, without blanks or duplicates.
    static func owners(_ repos: [GitHubRepo]) -> [String] {
        Array(Set(repos.map(\.owner).filter { !$0.isEmpty })).sorted()
    }

    /// Owner AND query, case-insensitive, matching the full name or the name.
    /// `owner` nil = all owners.
    static func filter(repos: [GitHubRepo], owner: String?, query: String) -> [GitHubRepo] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return repos.filter { repo in
            if let owner, !owner.isEmpty, repo.owner != owner { return false }
            if q.isEmpty { return true }
            return repo.fullName.lowercased().contains(q) || repo.name.lowercased().contains(q)
        }
    }
}

enum CloneProgressCopy {
    /// Human file size ("1.5 MB"). `ByteCountFormatter` `.file` style — the unit
    /// the user sees in Files and Finder.
    static func bytes(_ count: Double) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(max(0, count)))
    }

    /// "Cloning api · 42% · 1.5 MB".
    static func headline(name: String, percent: Double, bytes: Double) -> String {
        "Cloning \(name) · \(Int(max(0, min(100, percent)).rounded()))% · \(Self.bytes(bytes))"
    }
}

/// Repeated clone polling is bounded: the box times a clone out at 120 s, and
/// the client gives up a little after.
enum CloneTiming {
    static let pollInterval: TimeInterval = 0.5
    static let timeout: TimeInterval = 130
    /// Consecutive failed status reads before the clone UI gives up.
    static let maxConsecutiveThrows = 3
}
