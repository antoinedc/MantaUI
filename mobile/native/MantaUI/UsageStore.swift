import Foundation
import Combine

// ===========================================================================
// BET-824 — plan-usage poller.
//
// Owns the `usage:list` snapshot set and re-reads the box on a 60s cadence
// while the chat is open (the box refreshes its own snapshot every 3 minutes,
// so 60s is comfortably finer than the source). The dot, the usage sheet and
// the weekly banner all read from this one store, so the snapshot set is
// fetched once and shared rather than polled per surface.
// ===========================================================================

@MainActor
final class UsageStore: ObservableObject {

    /// The snapshots as last returned by `usage:list`, empty until the first
    /// successful fetch (empty set → every window lookup misses → the dot is
    /// absent — the honest "no data yet" state, not a confident green).
    @Published private(set) var snapshots: [UsageSnapshot] = []
    /// When the last successful fetch landed — the "Updated Xm ago" stamp.
    @Published private(set) var lastFetch: Date?

    private let api: MantaAPIClient
    private let pollInterval: TimeInterval
    private var pollTask: Task<Void, Never>?

    init(api: MantaAPIClient, pollInterval: TimeInterval = 60) {
        self.api = api
        self.pollInterval = pollInterval
    }

    /// Begin the 60s poll. Run once; repeat calls are no-ops while running.
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetch()
                if let interval = self?.pollInterval {
                    try? await Task.sleep(for: .seconds(interval))
                }
            }
        }
    }

    /// Stop the poll. Cancels the in-flight wait so the screen can disappear
    /// without a stale task writing after teardown.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func fetch() async {
        guard let fetched = try? await api.usageList() else { return }
        snapshots = fetched
        lastFetch = Date()
    }
}
