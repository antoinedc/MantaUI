import Foundation
import Combine

// ===========================================================================
// WS10 F15 — "Remove server": the I/O around the pure `BoxRemovalFlow` reducer.
//
// Order is the whole point: (1) revoke ONLY this phone's own device on the box,
// (2) delete the Keychain credentials, (3) show any warning the user must see,
// (4) only then leave — `.mantaBoxRemoved` makes the app root return to
// onboarding. So a relaunch never resurrects a "removed" pairing, and a warning
// is never lost behind a screen change. If the Keychain delete throws, the app
// stays paired and "Try again" repeats ONLY the local delete — never the remote
// revoke, whose answer is carried in the state.
// ===========================================================================

@MainActor
final class BoxRemovalStore: ObservableObject {

    struct Dependencies: Sendable {
        var devices: @Sendable () async throws -> BoxDevicesResponse
        var revoke: @Sendable (String) async -> (status: Int?, transportError: Bool)
        var deleteCredentials: @Sendable () throws -> Void

        static func live() -> Dependencies {
            let rest = BoxRESTClient.live()
            return Dependencies(
                devices: { try await rest.devices() },
                revoke: { await rest.revokeDevice(id: $0) },
                deleteCredentials: { try KeychainCredentialStore.shared.delete() }
            )
        }
    }

    @Published private(set) var state: BoxRemovalState = .idle

    /// Rows are disabled while a removal is underway.
    var isBusy: Bool {
        switch state {
        case .revoking, .deletingLocal: return true
        default: return false
        }
    }

    private let deps: Dependencies
    private let announceRemoved: @MainActor () -> Void
    private var didLeave = false

    init(dependencies: Dependencies = .live(),
         announceRemoved: @escaping @MainActor () -> Void = {
             NotificationCenter.default.post(name: .mantaBoxRemoved, object: nil)
         }) {
        self.deps = dependencies
        self.announceRemoved = announceRemoved
    }

    // MARK: - User actions

    func begin() { send(.tapRemove) }

    func cancel() { send(.cancel) }

    /// "Remove" in the confirmation.
    func confirm() {
        guard state == .confirming else { return }
        send(.confirm)
        Task { await runRemote() }
    }

    /// "Try again" after a Keychain failure — repeats ONLY the local delete.
    func retryLocal() {
        guard case .localDeleteFailed = state else { return }
        send(.retryLocal)
        attemptLocalDelete()
    }

    /// "OK" on the warning.
    func acknowledge() {
        send(.acknowledge)
        leaveIfDone()
    }

    // MARK: - Steps

    private func runRemote() async {
        let remote: RemoteRevokeResult
        do {
            let response = try await deps.devices()
            switch BoxRemoval.plan(devices: response.devices) {
            case .revoke(let deviceID):
                let answer = await deps.revoke(deviceID)
                remote = BoxRemoval.classify(status: answer.status, transportError: answer.transportError)
            case .sharedPairing:
                remote = .sharedPairing
            case .unknownDevice:
                remote = .unknownDevice
            }
        } catch MantaError.authRequired {
            // This phone's token is already dead: nothing to revoke.
            remote = .alreadySignedOut
        } catch {
            remote = .unreachable(SettingsError.message(error))
        }
        send(.remoteFinished(remote))
        attemptLocalDelete()
    }

    private func attemptLocalDelete() {
        do {
            try deps.deleteCredentials()
            send(.localDeleted)
        } catch {
            send(.localDeleteFailed(Self.describe(error)))
        }
        leaveIfDone()
    }

    private func leaveIfDone() {
        guard state == .leaving, !didLeave else { return }
        didLeave = true
        announceRemoved()
    }

    private func send(_ event: BoxRemovalEvent) {
        state = BoxRemovalFlow.reduce(state, event)
    }

    private static func describe(_ error: Error) -> String {
        if case KeychainError.status(let code) = error { return "Keychain error \(code)" }
        return error.localizedDescription
    }
}
