import Foundation
import Combine

// ===========================================================================
// Box upgrade store (OpenCode V2 cutover, slice C4 — contract K3).
//
// Owns what the device knows about the box's upgrade and nothing else. READ
// ONLY: it never calls retry or rollback (those are desktop actions). Three
// producers feed `gate`, in one place so they cannot disagree:
//
//   - `{kind:"upgrade"}` frames on /events (the whole K3 object, every change)
//   - a refused call (`503 {upgrade:true}`, posted by MantaAPIClient)
//   - reads of `GET /api/upgrade`: when the stream connects (frames sent while
//     it was down are never replayed), when the app returns to the foreground,
//     and once a second WHILE the stream is down AND an upgrade is believed to
//     be running — manta-server restarts during an upgrade, which is exactly
//     when no frame can arrive. With nothing upgrading it does not poll: a
//     phone that is merely offline must not hammer the network.
//
// A failed read is never read as "the upgrade is over": only a successful
// answer (including an old box's 404 → nil) changes `gate`.
// ===========================================================================

@MainActor
final class UpgradeStore: ObservableObject {
    typealias Fetcher = @Sendable () async throws -> UpgradeStatus?

    @Published private(set) var gate = UpgradeGateState()

    /// What to render; nil → the app opens normally.
    var screen: UpgradeScreenModel? { UpgradeScreenModel.make(gate) }

    private let fetch: Fetcher
    private let pollInterval: Duration
    private var pollTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()
    private var bound = false
    private(set) var connected = false
    private var reading = false
    private var readAgain = false

    init(
        fetch: @escaping Fetcher = { try await MantaAPIClient.live().upgradeStatus() },
        pollInterval: Duration = .seconds(1)
    ) {
        self.fetch = fetch
        self.pollInterval = pollInterval
    }

    /// Attach to the app's event stream. Idempotent (the raw-frame handler list
    /// has no unsubscribe, so binding twice would double-apply every frame).
    func bind(eventStore: MantaEventStore) {
        guard !bound else { return }
        bound = true

        eventStore.addRawFrameHandler { [weak self] frame in
            guard let status = UpgradeStatus.from(frame: frame) else { return }
            Task { @MainActor in self?.apply(status) }
        }

        eventStore.$connectionState
            .map { $0.name == "connected" }
            .removeDuplicates()
            .sink { [weak self] isConnected in
                Task { @MainActor in self?.connectionChanged(connected: isConnected) }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .mantaBoxUpgrading)
            .sink { [weak self] _ in
                Task { @MainActor in self?.noteUpgradeMode() }
            }
            .store(in: &cancellables)

        Task { await read() }
    }

    /// Foreground / pull: re-read now.
    func refresh() async {
        await read()
    }

    // MARK: - Producers

    func apply(_ status: UpgradeStatus?) {
        gate.apply(status: status)
        updatePolling()
    }

    /// A data call was refused `503 {upgrade:true}`.
    func noteUpgradeMode() {
        gate.markUpgradeMode()
        updatePolling()
        Task { await read() }
    }

    func connectionChanged(connected isConnected: Bool) {
        connected = isConnected
        if isConnected {
            // Frames sent while the stream was down are not replayed: re-read.
            Task { await read() }
        }
        updatePolling()
    }

    // MARK: - Reads

    /// One read at a time. A request that arrives while one is in flight is not
    /// dropped — the in-flight answer may predate the event that asked — it
    /// re-reads once that one settles.
    func read() async {
        if reading {
            readAgain = true
            return
        }
        reading = true
        do {
            let status = try await fetch()
            gate.apply(status: status)
        } catch {
            // Box restarting / offline / 401: not an answer. Keep what we had;
            // the poll or the next frame settles it.
        }
        reading = false
        updatePolling()
        if readAgain {
            readAgain = false
            await read()
        }
    }

    // MARK: - Polling (only while an upgrade is believed active and the stream is down)

    private func updatePolling() {
        if !connected && gate.isActive {
            startPolling()
        } else {
            stopPolling()
        }
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        let interval = pollInterval
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard let self, !Task.isCancelled else { return }
                await self.read()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    // No deinit: the poll task holds `self` weakly and ends as soon as the store
    // is gone, so there is nothing to tear down (and a nonisolated deinit may
    // not touch this main-actor state under Swift 6).
}
