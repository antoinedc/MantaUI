import Combine
import Foundation

/// Which clamped prompts the user has expanded, keyed by the transcript row's
/// identity (`TranscriptBlock.stableScrollID` — a user block carries no message
/// id, and that is the identity the list itself recycles and refetches by).
///
/// Held here and not in the cell's `@State`: a transcript cell is recycled on
/// scroll and a `@State` would forget the choice (mobile/native/AGENTS.md §6).
/// One app-wide instance — ids are unique per row, so chats never collide.
@MainActor
final class TranscriptExpansionStore: ObservableObject {
    static let shared = TranscriptExpansionStore()

    @Published private(set) var expandedIDs: Set<String> = []

    init() {}

    func isExpanded(_ id: String) -> Bool { expandedIDs.contains(id) }

    func toggle(_ id: String) {
        if !expandedIDs.insert(id).inserted { expandedIDs.remove(id) }
    }
}
