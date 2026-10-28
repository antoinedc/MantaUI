import Combine
import Foundation

// ===========================================================================
// WS11 D1 — the app's ONE capability reader. Owned by `MantaAppRoot`, injected as
// an `@EnvironmentObject`, refreshed on the event stream's (re)connect, reset on a
// box change. Three states, never conflated: `loading`, `loaded`, `failed` (a
// failed read is NOT evidence of an old box and keeps the last good list).
//
//   has(_:) → true  (the box lists it)
//             false (the box answered and does not — an older box)
//             nil   (not known yet / the box could not be asked)
// ===========================================================================

@MainActor
final class BoxCapabilitiesStore: ObservableObject {
    @Published private(set) var state: BoxCapabilitiesState = .loading

    private let load: @Sendable () async throws -> ServerVersionInfo
    /// The one read in progress. A caller that arrives while it runs WAITS for it, so
    /// a first chat open never reads "unknown" because it raced the app-level read.
    private var loadTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var failedAttempts = 0
    private var generation = 0

    init(api: MantaAPIClient) {
        load = { try await api.apiVersion() }
    }

    /// The app's store: each read goes to the CURRENT paired box (the live client is
    /// built per call, so a box switch never reads through a stale server URL).
    init() {
        load = { try await MantaAPIClient.live().apiVersion() }
    }

    /// Test seam: a fixed loader.
    init(load: @escaping @Sendable () async throws -> ServerVersionInfo) {
        self.load = load
    }

    /// The list to answer from (the loaded one, or the last good one after a failure).
    var current: BoxCapabilities? { state.known }

    func has(_ capability: BoxCapability) -> Bool? {
        current.map { $0.has(capability) }
    }

    /// Ask the box. Concurrent callers share one request. A failure keeps the last
    /// answer and schedules a retry on the 1 s → 2 s → 5 s → 10 s schedule.
    func refresh() async {
        if let running = loadTask {
            await running.value
            return
        }
        let load = self.load
        let startedIn = generation
        let task = Task { [weak self] in
            do {
                let info = try await load()
                guard let self, self.generation == startedIn else { return }
                self.failedAttempts = 0
                self.retryTask?.cancel()
                self.retryTask = nil
                let loaded = BoxCapabilities.decode(version: info)
                if self.state != .loaded(loaded) { self.state = .loaded(loaded) }
            } catch {
                guard let self, self.generation == startedIn else { return }
                NSLog("[capabilities] couldn't read the box capabilities: %@", String(describing: error))
                self.state = .failed(lastLoaded: self.state.known)
                self.scheduleRetry()
            }
            self?.loadTask = nil
        }
        loadTask = task
        await task.value
    }

    /// A different box (or none): forget everything the last one said.
    func resetForBoxChange() {
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        retryTask?.cancel()
        retryTask = nil
        failedAttempts = 0
        state = .loading
    }

    /// Test seam.
    func apply(_ ids: Set<String>) {
        retryTask?.cancel()
        retryTask = nil
        state = .loaded(BoxCapabilities(ids: ids))
    }

    private func scheduleRetry() {
        retryTask?.cancel()
        let delay = BoxCapabilitiesRetry.delay(attempt: failedAttempts)
        failedAttempts += 1
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }
}
