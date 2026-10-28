import Foundation

// ===========================================================================
// WS08 — serialising the provider-wide device wait (connect flow only).
//
// The box keeps ONE device-wait slot per opencode provider id, fills it inside
// `start` before it replies, and `oauth-cancel {id}` deletes that slot whoever
// filled it. A client attempt id cannot scope that. Without serialisation:
// start A in flight → Cancel → Connect again (B starts and fills the slot) →
// A's late reply → A's cleanup cancels B's wait → B fails although the user
// approved B's code.
//
// Rule: for one provider id, a device-wait START and the CLEANUP of the attempt
// that issued it are one critical section. A newer attempt's start waits until
// the previous section has finished, and the provider-wide cancel is only ever
// sent by the attempt that currently owns the slot.
//
// `ProviderOAuthLeaseState` is the pure reducer (unit-tested); `ProviderOAuthLease`
// only executes its actions. Foundation-only.
// ===========================================================================

enum ProviderOAuthLeaseEvent: Equatable, Sendable {
    /// An attempt wants to start a device wait.
    case request(UUID)
    /// The owner's start call returned (or threw).
    case startFinished(UUID)
    /// The attempt is being abandoned.
    case retire(UUID)
    /// The provider-wide cancel finished — successfully or not. Either way the
    /// slot is free (the box's own expiry is the backstop for a failed cancel).
    case cancelFinished
    /// The wait reached a terminal state on the box: free without cancelling.
    case settled(UUID)
}

enum LeaseAction: Equatable, Sendable {
    case runStart(UUID)
    case sendCancel(String)
    case drop(UUID)
}

struct ProviderOAuthLeaseState: Equatable, Sendable {
    let provider: String
    private(set) var owner: UUID?
    private(set) var ownerStartInFlight = false
    private(set) var retirePending = false
    /// The provider-wide cancel has been issued and has not finished.
    private(set) var cancelling = false
    private(set) var waiters: [UUID] = []

    init(provider: String) {
        self.provider = provider
    }

    var isIdle: Bool { owner == nil && waiters.isEmpty }

    mutating func reduce(_ event: ProviderOAuthLeaseEvent) -> [LeaseAction] {
        switch event {
        case .request(let attempt):
            if owner == nil {
                claim(attempt)
                return [.runStart(attempt)]
            }
            if owner != attempt, !waiters.contains(attempt) { waiters.append(attempt) }
            return []

        case .startFinished(let attempt):
            guard owner == attempt, ownerStartInFlight else { return [] }
            ownerStartInFlight = false
            if retirePending, !cancelling {
                cancelling = true
                return [.sendCancel(provider)]
            }
            return []

        case .retire(let attempt):
            if let index = waiters.firstIndex(of: attempt) {
                waiters.remove(at: index)
                return [.drop(attempt)]
            }
            guard owner == attempt, !cancelling else { return [] }
            if ownerStartInFlight {
                // The reply has not landed: the cancel goes out when it does,
                // so it can never overtake the slot being filled.
                retirePending = true
                return []
            }
            cancelling = true
            return [.sendCancel(provider)]

        case .cancelFinished:
            guard cancelling else { return [] }
            return release()

        case .settled(let attempt):
            guard owner == attempt, !cancelling else { return [] }
            return release()
        }
    }

    private mutating func claim(_ attempt: UUID) {
        owner = attempt
        ownerStartInFlight = true
        retirePending = false
        cancelling = false
    }

    private mutating func release() -> [LeaseAction] {
        owner = nil
        ownerStartInFlight = false
        retirePending = false
        cancelling = false
        guard !waiters.isEmpty else { return [] }
        let next = waiters.removeFirst()
        claim(next)
        return [.runStart(next)]
    }
}

@MainActor
final class ProviderOAuthLease {
    /// App-lifetime, like `ChatModelCatalog.shared`: it must outlive a sheet's
    /// dismissal and a screen's recreation, because the late reply of a
    /// cancelled start arrives after both.
    static let shared = ProviderOAuthLease()

    typealias CancelTransport = @MainActor (String) async throws -> Void

    private var cancelTransport: CancelTransport
    private var states: [String: ProviderOAuthLeaseState] = [:]
    private var startWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
    private var cancelWaiters: [String: [CheckedContinuation<Result<Void, MantaError>, Never>]] = [:]

    init(cancel: @escaping CancelTransport = { _ in }) {
        self.cancelTransport = cancel
    }

    /// Production: `ProviderConnectFlow` calls this once before its first start
    /// with the real `oauth-cancel` call.
    func configure(cancel: @escaping CancelTransport) {
        cancelTransport = cancel
    }

    /// Waits until no earlier attempt holds or is cleaning up `provider`, marks
    /// `attempt` the owner and runs `start`. Returns nil — and starts nothing —
    /// if `attempt` was retired before its turn came.
    func start<T>(provider: String, attempt: UUID, _ start: @MainActor () async throws -> T) async throws -> T? {
        var state = states[provider] ?? ProviderOAuthLeaseState(provider: provider)
        let immediate = state.reduce(.request(attempt))
        states[provider] = state

        let mayRun: Bool
        if immediate.contains(.runStart(attempt)) {
            mayRun = true
        } else {
            mayRun = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                startWaiters[attempt] = continuation
            }
        }
        guard mayRun else { return nil }

        // Retired in the gap between being granted the slot and running.
        if let current = states[provider], current.owner == attempt, current.retirePending {
            apply(provider, .startFinished(attempt))
            return nil
        }

        do {
            let value = try await start()
            apply(provider, .startFinished(attempt))
            return value
        } catch {
            apply(provider, .startFinished(attempt))
            throw error
        }
    }

    /// Retire `attempt`. Only the slot's owner ever causes a provider-wide
    /// cancel; the result is that cancel's outcome (`.success` when there was
    /// nothing to send). The slot is freed after the cancel completes.
    func retire(provider: String, attempt: UUID) async -> Result<Void, MantaError> {
        guard var state = states[provider] else { return .success(()) }
        let ownsSlot = state.owner == attempt
        let alreadyCancelling = ownsSlot && state.cancelling
        let actions = state.reduce(.retire(attempt))
        states[provider] = state
        run(actions, provider: provider)

        guard ownsSlot else { return .success(()) }
        let willCancel = actions.contains(.sendCancel(provider)) || alreadyCancelling || state.retirePending
        guard willCancel else { return .success(()) }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Result<Void, MantaError>, Never>) in
            cancelWaiters[provider, default: []].append(continuation)
        }
    }

    /// The device wait reached a terminal state on the box (ok / error).
    func settled(provider: String, attempt: UUID) {
        apply(provider, .settled(attempt))
    }

    // MARK: - Executing the reducer

    private func apply(_ provider: String, _ event: ProviderOAuthLeaseEvent) {
        var state = states[provider] ?? ProviderOAuthLeaseState(provider: provider)
        let actions = state.reduce(event)
        states[provider] = state.isIdle ? nil : state
        run(actions, provider: provider)
    }

    private func run(_ actions: [LeaseAction], provider: String) {
        for action in actions {
            switch action {
            case .runStart(let attempt):
                startWaiters.removeValue(forKey: attempt)?.resume(returning: true)
            case .drop(let attempt):
                startWaiters.removeValue(forKey: attempt)?.resume(returning: false)
            case .sendCancel(let id):
                sendCancel(provider: id)
            }
        }
    }

    private func sendCancel(provider: String) {
        let transport = cancelTransport
        Task { @MainActor [weak self] in
            let result: Result<Void, MantaError>
            do {
                try await transport(provider)
                result = .success(())
            } catch let error as MantaError {
                result = .failure(error)
            } catch {
                result = .failure(.transport(error.localizedDescription))
            }
            self?.cancelFinished(provider: provider, result: result)
        }
    }

    private func cancelFinished(provider: String, result: Result<Void, MantaError>) {
        let waiting = cancelWaiters.removeValue(forKey: provider) ?? []
        apply(provider, .cancelFinished)
        for continuation in waiting { continuation.resume(returning: result) }
    }
}
