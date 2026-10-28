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

    @Published private(set) var targets: [UpdateTarget] = []
    @Published private(set) var checking = false
    @Published private(set) var checkedAt: Date?
    @Published private(set) var serverVersion: String?
    @Published private(set) var flow = UpdateFlow()
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
    func check() async {
        guard !checking else { return }
        checking = true
        if let info = try? await deps.version() { serverVersion = info.version }
        let verdict: ServerUpdateCheck?
        do {
            verdict = try await Self.withDeadline(checkTimeout, deps.check)
        } catch {
            verdict = nil
        }
        targets = UpdateTargets.build(check: verdict, serverVersion: serverVersion)
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
        flow.reduce(.cancelConfirm)
    }

    /// "Update & restart" in the confirm. Starts the apply call and the watch loop.
    func confirmServerUpdate() {
        guard flow.phase == .confirming else { return }
        flow.reduce(.confirm(fromVersion: serverVersion, now: now()))
        startTicking()
        Task { await runApply() }
    }

    private func runApply() async {
        let raw = await deps.apply()
        flow.reduce(.applyOutcome(UpdateApplyClassifier.classify(raw)))
        finishIfSettled()
    }

    /// The event stream's connection state (fed by the screen).
    func connectionChanged(connected: Bool) {
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
