import Foundation
import Combine

// ===========================================================================
// WS10 F18 — the Software updates screen's state. The decisions are in
// `SettingsUpdatesModels.swift` (rows, the apply classifier, the `UpdateFlow`
// reducer); this is the I/O + published-state wiring around them. Created by the
// screen and alive only while it is.
//
// The box restarts ITSELF as the last step of a server update, so the apply call
// usually never answers cleanly. Success is therefore decided by the only signal
// that cannot lie: the box's version CHANGED after it came back. While an update
// is in flight a once-per-`tickInterval` loop re-reads the version (a failed read
// is just "still down") and advances the safety cap.
//
// All I/O is injected so the wiring is testable without a box.
// ===========================================================================

@MainActor
final class SettingsUpdatesStore: ObservableObject {

    struct Dependencies: Sendable {
        var version: @Sendable () async throws -> ServerVersionInfo
        var check: @Sendable () async throws -> ServerUpdateCheck
        var cliUpdate: @Sendable (String) async throws -> CliUpdateResult
        var apply: @Sendable () async -> RawRPCResponse

        static func live() -> Dependencies {
            let api = MantaAPIClient.live()
            let rest = BoxRESTClient.live()
            return Dependencies(
                version: { try await api.serverVersion() },
                check: { try await api.serverUpdateCheck() },
                cliUpdate: { try await api.serverCliUpdate(cliID: $0) },
                apply: { await rest.rpcRaw(channel: "server:update-apply", args: [], timeout: 30) }
            )
        }
    }

    /// The rows, as the box worded them (`server:update-check` → `view.targets`).
    @Published private(set) var targets: [UpdateTargetView] = []
    /// No verdict arrived (the check timed out or failed): never shown as "up to date".
    /// "Update manually" links by target id (from the raw targets; a link is data, not wording).
    @Published private(set) var manualUrls: [String: String] = [:]
    @Published private(set) var checkFailed = false
    /// A verdict arrived without `view`: an older box — the rows are replaced by the update note.
    @Published private(set) var needsBoxUpdate = false
    @Published private(set) var checking = false
    @Published private(set) var checkedAt: Date?
    @Published private(set) var serverVersion: String?
    @Published private(set) var flow = UpdateFlow()
    /// `confirmServerUpdate` is between its tap and its first state change.
    @Published private(set) var startingUpdate = false
    /// The CLI row being updated, if any.
    @Published private(set) var cliUpdatingID: String?
    /// Per-row error text (a failed CLI update).
    @Published private(set) var rowErrors: [String: String] = [:]

    /// True when the main update flow or a CLI update is running — every other
    /// Update button is disabled.
    var isUpdating: Bool { flow.isBusy || cliUpdatingID != nil }

    private let deps: Dependencies
    private let checkTimeout: Double
    private let tickInterval: Duration
    private let now: @Sendable () -> Date
    private var tickTask: Task<Void, Never>?
    /// The check in flight, so a second caller awaits it instead of returning early.
    private var checkTask: Task<Void, Never>?
    /// `confirmServerUpdate` is between its tap and its first state change.
    private var startTask: Task<Void, Never>?
    private var connectionSubscription: AnyCancellable?

    init(dependencies: Dependencies = .live(),
         checkTimeout: Double = 15,
         tickInterval: Duration = .seconds(3),
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.deps = dependencies
        self.checkTimeout = checkTimeout
        self.tickInterval = tickInterval
        self.now = now
    }

    // MARK: - Check

    /// Read the box version and the update verdict. A check that fails or times
    /// out is a server row reading "Couldn't check" — never "Up to date".
    ///
    /// A call made while a check is already running AWAITS that check (rather
    /// than returning at once), so a caller that re-checks before clearing its
    /// spinner never reads stale rows.
    func check() async {
        if let running = checkTask {
            await running.value
            return
        }
        let task = Task { await performCheck() }
        checkTask = task
        await task.value
    }

    private func performCheck() async {
        checking = true
        defer { checkTask = nil }
        if let info = try? await deps.version() { serverVersion = info.version }
        let verdict: ServerUpdateCheck?
        do {
            verdict = try await Self.withDeadline(checkTimeout, deps.check)
        } catch {
            verdict = nil
        }
        manualUrls = Dictionary(uniqueKeysWithValues: (verdict?.targets ?? []).compactMap { t in t.manualUrl.map { (t.id, $0) } })
        if let view = verdict?.view {
            targets = view.targets
            checkFailed = false
            needsBoxUpdate = false
        } else {
            targets = []
            checkFailed = verdict == nil
            needsBoxUpdate = verdict != nil
        }
        checkedAt = now()
        checking = false
    }

    // MARK: - Server update (confirm → apply → wait for the new version)

    func requestServerUpdate() {
        // A finished/failed flow is acknowledged by asking again.
        if !flow.isBusy { flow.reduce(.dismiss) }
        guard cliUpdatingID == nil else { return }
        flow.reduce(.requestConfirm)
    }

    func cancelServerUpdate() {
        guard !startingUpdate else { return }
        flow.reduce(.cancelConfirm)
    }

    /// "Update & restart" in the confirm. Starts the apply call and the watch loop.
    ///
    /// Success is decided by the version CHANGING, so the starting version must be
    /// known: with none, a perfectly good update could only ever end as "Couldn't
    /// confirm" after ten minutes. If the current version is unknown it is read
    /// first; if it still can't be read, the flow ends without applying anything.
    ///
    /// Synchronous on purpose: `startingUpdate` is set before this returns, so the
    /// confirmation dialog's own dismissal (which calls `cancelServerUpdate`
    /// right after the button action) can't cancel an update that is starting.
    func confirmServerUpdate() {
        guard flow.phase == .confirming, !startingUpdate else { return }
        startingUpdate = true
        startTask = Task { await beginServerUpdate() }
    }

    /// Resolves once the update has started (or been refused) — the apply call
    /// itself is not awaited. For tests.
    func settledStart() async {
        await startTask?.value
    }

    private func beginServerUpdate() async {
        defer { startingUpdate = false }
        if serverVersion == nil, let info = try? await deps.version() { serverVersion = info.version }
        guard flow.phase == .confirming else { return }
        guard let from = serverVersion else {
            flow.reduce(.abort(Self.unknownVersionMessage))
            return
        }
        flow.reduce(.confirm(fromVersion: from, now: now()))
        startTicking()
        Task { await runApply() }
    }

    static let unknownVersionMessage = "Couldn't read the box's current version. Check again."

    private func runApply() async {
        let raw = await deps.apply()
        flow.reduce(.applyOutcome(UpdateApplyClassifier.classify(raw)))
        finishIfSettled()
    }

    /// Subscribe ONCE to the event stream's up/down edge. Idempotent: a second
    /// call (the screen's task re-running) keeps the first subscription, so a
    /// `@Published` replay can never be delivered twice.
    func bind(connection: AnyPublisher<Bool, Never>) {
        guard connectionSubscription == nil else { return }
        connectionSubscription = connection
            .removeDuplicates()
            .sink { [weak self] connected in
                Task { @MainActor in self?.connectionChanged(connected: connected) }
            }
    }

    /// The event stream's connection state. Idempotent: a repeated value changes
    /// nothing and publishes nothing (a replayed value must not re-render the
    /// screen, which would re-subscribe and loop).
    func connectionChanged(connected: Bool) {
        guard connected != flow.connected else { return }
        flow.reduce(.connection(connected))
        if connected, flow.isBusy { Task { await readVersionAfterRestart() } }
    }

    private func startTicking() {
        tickTask?.cancel()
        let interval = tickInterval
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard let self, !Task.isCancelled else { return }
                guard await self.tick() else { return }
            }
        }
    }

    /// One watch step. Returns false when the flow is no longer waiting.
    private func tick() async -> Bool {
        guard flow.phase == .applying || flow.phase == .restarting else { return false }
        flow.reduce(.tick(now()))
        if flow.phase == .applying || flow.phase == .restarting {
            await readVersionAfterRestart()
        }
        return finishIfSettled()
    }

    /// A failed read is "still down", never an answer.
    private func readVersionAfterRestart() async {
        guard flow.phase == .applying || flow.phase == .restarting else { return }
        guard let info = try? await deps.version() else { return }
        flow.reduce(.version(info.version))
        if case .done(let landed) = flow.phase { serverVersion = landed }
        finishIfSettled()
    }

    /// When the flow reached a terminal phase: stop the watch loop, and after a
    /// success re-run the check so the row reflects the new state.
    @discardableResult
    private func finishIfSettled() -> Bool {
        switch flow.phase {
        case .done:
            tickTask?.cancel()
            tickTask = nil
            Task { await check() }
            return false
        case .failed, .timedOut, .idle:
            tickTask?.cancel()
            tickTask = nil
            return false
        case .confirming, .applying, .restarting:
            return true
        }
    }

    // MARK: - CLI update (no confirm — desktop parity)

    func updateCLI(_ id: String) async {
        guard !flow.isBusy, cliUpdatingID == nil else { return }
        cliUpdatingID = id
        rowErrors[id] = nil
        do {
            let result = try await deps.cliUpdate(id)
            if !result.ok {
                rowErrors[id] = (result.error?.isEmpty == false ? result.error : nil) ?? "Update failed"
            }
        } catch {
            rowErrors[id] = SettingsError.message(error)
        }
        // Re-run the check before clearing the spinner so the row reflects the
        // new version rather than flashing back to "Update available".
        await check()
        cliUpdatingID = nil
    }

    // MARK: - Helpers

    /// Race `operation` against a deadline; the loser is cancelled.
    private static func withDeadline<T: Sendable>(
        _ seconds: Double,
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw MantaError.transport("timed out")
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw MantaError.transport("timed out") }
            return first
        }
    }
}
