import Combine
import Foundation

// ===========================================================================
// WS08 — the data behind the provider sections of Settings → Accounts:
// subscription connections (`opencode:provider-auth status`), custom endpoints
// (`opencode:get-providers`) and the health engine's states (`accounts:health`).
//
// Refetch-driven like the desktop (no poll): it loads when the screen opens,
// on pull-to-refresh, and after every action it performs. Each source keeps its
// own phase so one failing call never hides the others — and a missing health
// reading is UNKNOWN, never "healthy".
//
// The actions here (disconnect, try again, per-model switches, refresh, probe,
// remove) each end in a visible banner, success or failure; nothing is silent.
// A write to `opencode:set-providers` is never assumed atomic: after any
// refused or thrown write the box is read back and `EndpointWriteReconcile`
// says what happened.
// ===========================================================================

@MainActor
final class ProviderConnectionsStore: ObservableObject {

    @Published private(set) var statuses: [SubscriptionStatus] = []
    @Published private(set) var statusPhase: ProviderSourcePhase = .idle
    @Published private(set) var endpoints: [ProviderEndpoint] = []
    @Published private(set) var endpointPhase: ProviderSourcePhase = .idle
    /// nil until the first reading; missing health is unknown, never healthy.
    @Published private(set) var health: AccountsHealth?
    /// Model ids from the last "Refresh model list", per endpoint id.
    @Published private(set) var discovered: [String: [String]] = [:]
    /// Models the user switched off on this screen visit, per endpoint id, so a
    /// switched-off row stays on screen and can be switched back on.
    @Published private(set) var switchedOff: [String: [String]] = [:]
    /// Endpoints with a write in flight (their switches disable).
    @Published private(set) var writing: Set<String> = []
    /// The model whose switch is mid-write, per endpoint id (a small spinner).
    @Published private(set) var pendingModel: [String: String] = [:]
    /// Endpoints whose last write could not be confirmed: switches disabled,
    /// "Couldn't confirm what's saved" + Refresh.
    @Published private(set) var unconfirmed: Set<String> = []
    /// The subscription whose disconnect / try-again is in flight.
    @Published private(set) var busyProvider: String?

    let api: MantaAPIClient

    private let say: @MainActor (String, Bool) -> Void
    private let refreshAccounts: @MainActor () async -> Void
    private let announceChange: @MainActor () -> Void
    private let clock: () -> Date
    /// The endpoint as it stood before the last write — what "no change" means
    /// when an unconfirmed endpoint is refreshed.
    private var lastConfirmed: [String: EndpointState] = [:]

    init(
        api: MantaAPIClient,
        announce: @escaping @MainActor (String, Bool) -> Void,
        refreshAccounts: @escaping @MainActor () async -> Void = {},
        announceChange: @escaping @MainActor () -> Void = { ProviderChange.announce() },
        clock: @escaping () -> Date = { Date() }
    ) {
        self.api = api
        self.say = announce
        self.refreshAccounts = refreshAccounts
        self.announceChange = announceChange
        self.clock = clock
    }

    // MARK: - Reading

    func load() async {
        async let statusRead: Void = loadStatuses()
        async let endpointRead: Void = loadEndpoints()
        async let healthRead: Void = loadHealth()
        _ = await (statusRead, endpointRead, healthRead)
    }

    func loadStatuses() async {
        if statusPhase != .loaded { statusPhase = .loading }
        do {
            statuses = try await api.providerAuthStatus()
            statusPhase = .loaded
        } catch {
            // A refresh that fails after a good load keeps what is on screen.
            if statusPhase != .loaded { statusPhase = .failed(AccountsCopy.reason(for: error)) }
        }
    }

    func loadEndpoints() async {
        if endpointPhase != .loaded { endpointPhase = .loading }
        do {
            adopt(try await api.providerEndpoints())
            endpointPhase = .loaded
        } catch {
            if endpointPhase != .loaded { endpointPhase = .failed(AccountsCopy.reason(for: error)) }
        }
    }

    func loadHealth() async {
        do {
            health = try await api.accountsHealth()
        } catch {
            // No reading is "unknown": keep the last one, never invent "healthy".
            NSLog("[accounts] health read failed: %@", String(describing: error))
        }
    }

    /// Take the box's endpoint list as the truth.
    private func adopt(_ list: [ProviderEndpoint]) {
        endpoints = list
        let ids = Set(list.map(\.id))
        discovered = discovered.filter { ids.contains($0.key) }
        switchedOff = switchedOff.filter { ids.contains($0.key) }
        unconfirmed = unconfirmed.intersection(ids)
        for endpoint in list where !unconfirmed.contains(endpoint.id) {
            lastConfirmed[endpoint.id] = endpoint.comparable
        }
    }

    /// A fresh, COMPLETE inventory for the add form's collision guard. The
    /// endpoint list is required (a failure throws); the subscription ids are
    /// best effort — the reserved ids always apply.
    func freshInventory() async throws -> (endpoints: [ProviderEndpoint], statusIds: [String]) {
        let list = try await api.providerEndpoints()
        var ids = statuses.map(\.id)
        if let fresh = try? await api.providerAuthStatus() { ids = fresh.map(\.id) }
        return (list, ids)
    }

    /// The add form saved (or partly saved) an endpoint.
    func endpointsChanged() async {
        async let endpointRead: Void = loadEndpoints()
        async let healthRead: Void = loadHealth()
        _ = await (endpointRead, healthRead)
    }

    // MARK: - Subscriptions

    func health(for providerID: String) -> ProviderHealthEntry? {
        health?.providers[providerID]
    }

    /// Disconnect a subscription: the box removes the credential and restarts
    /// opencode. The caller has already confirmed.
    func disconnect(_ status: SubscriptionStatus) async {
        guard busyProvider == nil else { return }
        busyProvider = status.id
        defer { busyProvider = nil }
        let label = status.displayName
        do {
            let reply = try await api.providerAuthDisconnect(id: status.id)
            if reply.ok {
                say(ProviderConnectCopy.disconnected(label: label), false)
                announceChange()
                await load()
                await refreshAccounts()
            } else {
                say(ProviderConnectCopy.disconnectFailed(label: label, reason: reply.error ?? "the box didn't confirm it"), true)
            }
        } catch {
            say(ProviderConnectCopy.disconnectFailed(label: label, reason: AccountsCopy.reason(for: error)), true)
        }
    }

    /// Out-of-credit "Try again": the box re-reads the meter and clears the flag
    /// only when funds are back. The message says which.
    func tryAgain(_ status: SubscriptionStatus) async {
        guard busyProvider == nil else { return }
        busyProvider = status.id
        defer { busyProvider = nil }
        do {
            let reply = try await api.accountsRetry(providerID: status.id)
            say(reply.message.isEmpty ? (reply.ok ? "\(status.displayName) is back." : "\(status.displayName) is still out of credit.") : reply.message, !reply.ok)
        } catch {
            say(AccountsCopy.failure("retry \(status.displayName)", error), true)
        }
        await loadHealth()
    }

    // MARK: - Endpoints

    func endpointRows(_ endpoint: ProviderEndpoint) -> [String] {
        ProviderEndpointModels.rows(
            enabled: endpoint.enabledModels,
            discovered: discovered[endpoint.id],
            disabledThisSession: switchedOff[endpoint.id] ?? []
        )
    }

    func healthRows(_ endpoint: ProviderEndpoint) -> [EndpointStateRow] {
        EndpointHealth.statesFor(providerID: endpoint.id, endpoints: health?.endpoints ?? [:])
    }

    func registerLine(_ endpoint: ProviderEndpoint) -> String? {
        EndpointHealth.registerLine(
            rows: healthRows(endpoint),
            enabledCount: endpoint.enabledModels.count,
            nowMs: clock().timeIntervalSince1970 * 1000
        )
    }

    func modelStateLine(_ endpoint: ProviderEndpoint, model: String) -> String? {
        guard let entry = health?.endpoints["\(endpoint.id)/\(model)"] else { return nil }
        let line = EndpointHealth.stateLine(entry, nowMs: clock().timeIntervalSince1970 * 1000)
        return line.isEmpty ? nil : line
    }

    /// One switch: write at once, single-flight per endpoint, and ADOPT what the
    /// box has afterwards (never an assumed rollback).
    func toggle(_ endpoint: ProviderEndpoint, model: String, on: Bool) async {
        guard !writing.contains(endpoint.id), !unconfirmed.contains(endpoint.id) else { return }
        let rows = endpointRows(endpoint)
        let selection = ProviderEndpointModels.toggled(enabled: endpoint.enabledModels, rows: rows, id: model, on: on)
        writing.insert(endpoint.id)
        pendingModel[endpoint.id] = model
        defer {
            writing.remove(endpoint.id)
            pendingModel[endpoint.id] = nil
        }
        if !on, !(switchedOff[endpoint.id] ?? []).contains(model) {
            switchedOff[endpoint.id, default: []].append(model)
        }
        lastConfirmed[endpoint.id] = endpoint.comparable
        // The switch moves at once; the box's answer decides whether it stays.
        if let index = endpoints.firstIndex(where: { $0.id == endpoint.id }) {
            endpoints[index].enabledModels = selection
        }

        let input = ProviderEndpointInput(id: endpoint.id, name: endpoint.name, baseURL: endpoint.baseURL, apiKey: nil, enabledModels: selection)
        let outcome = await write(
            upsert: [input], remove: [], before: endpoint,
            expect: .present(id: endpoint.id, enabledModels: selection)
        )
        let name = endpoint.name
        switch outcome {
        case .confirmed:
            break
        case .partial(let error):
            say(ProviderEndpointCopy.togglePartial(name: name, reason: error), true)
        case .rejected(let error):
            say(ProviderEndpointCopy.updateFailed(name: name, reason: error), true)
        case .unconfirmed:
            unconfirmed.insert(endpoint.id)
        }
        if ProviderChange.shouldAnnounce(outcome.changeOutcome) { announceChange() }
        await loadHealth()
    }

    /// An unconfirmed endpoint: read the box again; on success its switches
    /// adopt the box's state and are enabled again.
    func refreshUnconfirmed(_ endpoint: ProviderEndpoint) async {
        guard !writing.contains(endpoint.id) else { return }
        writing.insert(endpoint.id)
        defer { writing.remove(endpoint.id) }
        do {
            let list = try await api.providerEndpoints()
            let previous = lastConfirmed[endpoint.id]
            unconfirmed.remove(endpoint.id)
            adopt(list)
            endpointPhase = .loaded
            let now = list.first { $0.id == endpoint.id }?.comparable
            if now != previous { announceChange() }
        } catch {
            say(AccountsCopy.failure("refresh \(endpoint.name)", error), true)
        }
    }

    /// Re-list the endpoint's models from the box's network view. An empty key
    /// makes the box use the stored one.
    func refreshModels(_ endpoint: ProviderEndpoint) async {
        guard !writing.contains(endpoint.id) else { return }
        writing.insert(endpoint.id)
        defer { writing.remove(endpoint.id) }
        do {
            let result = try await api.providerDiscoverModels(baseURL: endpoint.baseURL, apiKey: "")
            if result.ok {
                discovered[endpoint.id] = result.models
                say(ProviderEndpointCopy.refreshFound(name: endpoint.name, count: result.models.count), false)
            } else {
                say(ProviderEndpointCopy.refreshFailed(name: endpoint.name, text: ProviderEndpointDraft.discoverErrorText(result)), true)
            }
        } catch {
            say(ProviderEndpointCopy.refreshFailed(name: endpoint.name, text: AccountsCopy.reason(for: error)), true)
        }
    }

    /// Whether "Send probe" has anything to probe.
    func probeKey(_ endpoint: ProviderEndpoint) -> String? {
        EndpointHealth.probeKey(providerID: endpoint.id, rows: healthRows(endpoint), enabledModels: endpoint.enabledModels)
    }

    func sendProbe(_ endpoint: ProviderEndpoint) async {
        guard let key = probeKey(endpoint) else { return }
        guard !writing.contains(endpoint.id) else { return }
        writing.insert(endpoint.id)
        defer { writing.remove(endpoint.id) }
        do {
            let reply = try await api.accountsEndpointProbe(endpointKey: key)
            say(reply.message.isEmpty ? (reply.ok ? "\(key) responded." : "\(key) did not respond.") : reply.message, !reply.ok)
        } catch {
            say(AccountsCopy.failure("probe \(endpoint.name)", error), true)
        }
        await loadHealth()
    }

    /// Remove an endpoint (the caller has confirmed).
    func remove(_ endpoint: ProviderEndpoint) async {
        guard !writing.contains(endpoint.id) else { return }
        writing.insert(endpoint.id)
        defer { writing.remove(endpoint.id) }
        lastConfirmed[endpoint.id] = endpoint.comparable
        let outcome = await write(upsert: [], remove: [endpoint.id], before: endpoint, expect: .absent(id: endpoint.id))
        switch outcome {
        case .confirmed:
            say(ProviderEndpointCopy.removed(name: endpoint.name), false)
        case .partial(let error), .rejected(let error):
            say(ProviderEndpointCopy.removeFailed(name: endpoint.name, reason: error), true)
        case .unconfirmed:
            unconfirmed.insert(endpoint.id)
        }
        if ProviderChange.shouldAnnounce(outcome.changeOutcome) { announceChange() }
        await loadHealth()
    }

    // MARK: - One write

    /// Send the write, and — unless the box said `{ok:true}` — read the box back
    /// and classify. The list shown afterwards is always the box's (the
    /// read-back), never the optimistic or pre-write guess; an unreadable box
    /// leaves the screen as it is and the outcome `.unconfirmed`.
    private func write(upsert: [ProviderEndpointInput], remove: [String], before: ProviderEndpoint?,
                       expect: EndpointWriteExpectation) async -> EndpointWriteOutcome {
        let reply: EndpointWriteReply
        do {
            let answer = try await api.providerSetEndpoints(upsert: upsert, remove: remove)
            reply = answer.ok ? .ok : .refused(answer.error ?? "the box refused the change")
        } catch {
            reply = .threw(AccountsCopy.reason(for: error))
        }
        var readBack: Result<[ProviderEndpoint], Error>?
        do {
            readBack = .success(try await api.providerEndpoints())
        } catch {
            readBack = .failure(error)
        }
        if case .success(let list)? = readBack {
            adopt(list)
            endpointPhase = .loaded
        }
        if case .ok = reply { return .confirmed }
        return EndpointWriteReconcile.outcome(reply: reply, before: before, readBack: readBack, expect: expect)
    }
}
