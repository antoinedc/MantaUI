import Foundation
import Combine

// ===========================================================================
// WS02 SF-0 — what the box says it can do (`server:version` → `capabilities`).
//
// The chat screen's read of the ONE capability list (`boxCapabilities.mjs`). A
// feature whose capability the box does not list is hidden or disabled with
// "Update your box to use this"; there is no fallback copy of the moved logic.
// WS11 later folds this into an app-level store.
//
//   has(_:) → true  (the box lists it)
//             false (the box answered and does not — an older box)
//             nil   (not known yet / the box could not be asked)
// ===========================================================================

@MainActor
final class ChatCardCapabilities: ObservableObject {
    /// The capability behind retry / compaction / send-error copy, the job view
    /// and refusal, and the inbox outcome copy.
    nonisolated static let chatCards = "chat-cards-1"
    static let updateBoxNote = ChatCardInboxGate.updateBoxNote

    @Published private(set) var ids: Set<String>?

    private let load: @Sendable () async throws -> Set<String>
    /// The one load in progress. A caller that arrives while it runs WAITS for it (it
    /// never returns early on a still-unknown list — that left the job-ownership
    /// resolve reading "unknown" on every first chat open).
    private var loadTask: Task<Void, Never>?

    init(api: MantaAPIClient) {
        load = { try await api.boxCapabilities() }
    }

    /// Test seam: a fixed loader.
    init(load: @escaping @Sendable () async throws -> Set<String>) {
        self.load = load
    }

    func has(_ id: String) -> Bool? {
        ids.map { $0.contains(id) }
    }

    /// Ask the box. Concurrent callers share one request and all return after it
    /// settles. A failure keeps the last answer (a hiccup must not turn a known
    /// capability back into "unknown").
    func refresh() async {
        if let running = loadTask {
            await running.value
            return
        }
        let load = self.load
        let task = Task { [weak self] in
            do {
                let loaded = try await load()
                if self?.ids != loaded { self?.ids = loaded }
            } catch {
                NSLog("[chat-cards] couldn't read the box capabilities: %@", String(describing: error))
            }
            self?.loadTask = nil
        }
        loadTask = task
        await task.value
    }

    /// Test seam.
    func apply(_ ids: Set<String>) {
        self.ids = ids
    }
}
