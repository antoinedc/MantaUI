import Combine
import Foundation

// ===========================================================================
// WS08 — "Add endpoint…": name, base URL, optional key → Test endpoint → a
// checklist of the endpoint's models → Save N models.
//
//   * The id is derived from the name; a name that collides with an existing
//     endpoint or a subscription id is refused before any network call, and
//     Save checks again against a FRESH inventory.
//   * Editing a field after a test clears the result, so a stale test can never
//     be saved.
//   * Saving never restarts opencode (the box hot-reloads).
//   * The write is not atomic: the outcome comes from `EndpointWriteReconcile`
//     (confirmed / saved-in-part / rejected / unconfirmed). An unconfirmed write
//     keeps its ORIGINAL expectation; pressing Save again re-reads the box and
//     classifies against that, never against the edited draft.
// ===========================================================================

@MainActor
final class ProviderEndpointFormModel: ObservableObject {

    enum Phase: Equatable {
        case editing
        case testing
        case tested
        case saving
    }

    @Published var name = "" { didSet { if name != oldValue { draftEdited() } } }
    @Published var baseURL = "" { didSet { if baseURL != oldValue { draftEdited() } } }
    @Published var apiKey = "" { didSet { if apiKey != oldValue { draftEdited() } } }

    @Published private(set) var phase: Phase = .editing
    @Published private(set) var checklist: ModelChecklistState?
    @Published private(set) var testError: String?
    @Published private(set) var saveError: String?
    @Published private(set) var shouldDismiss = false

    private let connections: ProviderConnectionsStore
    private let accounts: AccountsStore
    private let api: MantaAPIClient
    /// What an unconfirmed write was carrying; edits to the draft never touch it.
    private var pending: PendingEndpointWrite?

    init(connections: ProviderConnectionsStore, accounts: AccountsStore) {
        self.connections = connections
        self.accounts = accounts
        self.api = connections.api
    }

    // MARK: Derived

    var slug: String { ProviderEndpointDraft.slug(name) }

    private var takenIds: Set<String> {
        ProviderEndpointDraft.takenIds(endpoints: connections.endpoints, statusIds: connections.statuses.map(\.id))
    }

    var validationError: String? {
        ProviderEndpointDraft.validationError(name: name, baseURL: baseURL, takenIds: takenIds)
    }

    /// Shown once the user has typed something, not on an empty form.
    var visibleValidationError: String? {
        let started = !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return started ? validationError : nil
    }

    var canTest: Bool { validationError == nil && phase != .testing && phase != .saving }
    var isBusy: Bool { phase == .testing || phase == .saving }

    // MARK: Editing

    /// Any edit clears the test result (the "Edit details" step of the Mac
    /// form): a stale test can't be saved.
    private func draftEdited() {
        testError = nil
        saveError = nil
        guard checklist != nil, phase == .tested else { return }
        checklist = nil
        phase = .editing
    }

    func setFilter(_ text: String) { checklist?.filter = text }
    func setModel(_ id: String, selected: Bool) { checklist?.set(id, selected: selected) }
    func selectAllVisible() { checklist?.selectAllVisible() }
    func selectNoneVisible() { checklist?.selectNoneVisible() }

    // MARK: Test

    func test() async {
        guard canTest else { return }
        phase = .testing
        testError = nil
        saveError = nil
        do {
            let result = try await api.providerDiscoverModels(
                baseURL: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                apiKey: apiKey
            )
            if result.ok {
                checklist = ModelChecklistState(ids: result.models)
                phase = .tested
                if result.models.isEmpty { testError = "The endpoint answered, but it listed no models." }
            } else {
                testError = ProviderEndpointDraft.discoverErrorText(result)
                phase = .editing
            }
        } catch {
            testError = ProviderEndpointDraft.discoverErrorText(error: "unreachable", detail: AccountsCopy.reason(for: error))
            phase = .editing
        }
    }

    // MARK: Save

    func save() async {
        guard phase == .tested, let list = checklist, list.canSave, validationErrorIgnoringOwnPending == nil else { return }
        let id = slug
        let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = list.selectedIds
        phase = .saving
        saveError = nil

        // 1. A FRESH inventory: nothing is written on a failed read.
        let inventory: (endpoints: [ProviderEndpoint], statusIds: [String])
        do {
            inventory = try await connections.freshInventory()
        } catch {
            saveError = ProviderEndpointDraft.saveInventoryFailed
            phase = .tested
            return
        }

        // 2. After an unconfirmed write, classify against ITS expectation.
        if let earlier = pending {
            if earlier.id == id {
                switch EndpointWriteReconcile.recheck(pending: earlier, fresh: inventory.endpoints) {
                case .classified(let outcome):
                    pending = nil
                    let count: Int
                    if case .present(_, let models) = earlier.expect { count = models.count } else { count = selected.count }
                    await finish(outcome, name: displayName, count: count)
                    return
                case .writeAgain:
                    pending = nil
                }
            } else {
                // The user moved on to a different endpoint.
                pending = nil
            }
        }

        // 3. The collision guard, against that fresh list.
        if ProviderEndpointDraft.collision(slug: id, endpoints: inventory.endpoints, statusIds: inventory.statusIds) {
            saveError = ProviderEndpointDraft.collisionMessage(slug: id)
            phase = .tested
            return
        }

        // 4. Write. A new endpoint's key is sent as typed (empty = no key).
        let input = ProviderEndpointInput(id: id, name: displayName, baseURL: url, apiKey: apiKey.isEmpty ? nil : apiKey, enabledModels: selected)
        let expectation = EndpointWriteExpectation.present(id: id, enabledModels: selected)
        let reply: EndpointWriteReply
        do {
            let answer = try await api.providerSetEndpoints(upsert: [input], remove: [])
            reply = answer.ok ? .ok : .refused(answer.error ?? "the box refused the change")
        } catch {
            reply = .threw(AccountsCopy.reason(for: error))
        }
        var readBack: Result<[ProviderEndpoint], Error>?
        if case .ok = reply {
            readBack = nil
        } else {
            do {
                readBack = .success(try await api.providerEndpoints())
            } catch {
                readBack = .failure(error)
            }
        }
        let outcome = EndpointWriteReconcile.outcome(reply: reply, before: nil, readBack: readBack, expect: expectation)
        if case .unconfirmed = outcome {
            pending = PendingEndpointWrite(id: id, baseURL: url, before: nil, expect: expectation)
        }
        await finish(outcome, name: displayName, count: selected.count)
    }

    /// The draft is valid apart from a collision with the endpoint an earlier,
    /// unconfirmed save may already have written (the recheck decides that one).
    private var validationErrorIgnoringOwnPending: String? {
        var taken = takenIds
        if let pending, pending.id == slug { taken.remove(pending.id) }
        return ProviderEndpointDraft.validationError(name: name, baseURL: baseURL, takenIds: taken)
    }

    private func finish(_ outcome: EndpointWriteOutcome, name: String, count: Int) async {
        switch outcome {
        case .confirmed:
            accounts.announce(ProviderEndpointDraft.saved(name: name, count: count))
        case .partial(let error):
            accounts.announce(ProviderEndpointDraft.savedPartial(name: name, reason: error), isError: true)
        case .rejected(let error):
            saveError = error
            phase = .tested
            return
        case .unconfirmed:
            saveError = ProviderEndpointDraft.notConfirmed(name: name)
            phase = .tested
            return
        }
        if ProviderChange.shouldAnnounce(outcome.changeOutcome) { ProviderChange.announce() }
        phase = .tested
        shouldDismiss = true
        await connections.endpointsChanged()
    }
}
