import Combine
import Foundation

// ===========================================================================
// Multi-account & seats, phase 3 — the live data behind Settings → Accounts and
// the usage sheet.
//
// One store reads `accounts:list` (every provider → account → seat, with each
// seat's latest windows) and, when it is bound to a conversation,
// `accounts:session-seat` (which seat that conversation is on). It refetches
//   - when it starts (the screen opens),
//   - on every `accounts.updated` / `accounts.moved` bus event,
//   - when the event stream reconnects (an event may have been missed),
//   - on a 60 s cadence while it is running (a seat's percentages move without
//     any list change, and the composer dot reads them from here).
// and it runs the user's actions (mode, use seat, rename, remove), answering
// every one with a visible success or a specific failure — never silence.
//
// The decisions (which seat is "next", whether a switch needs a confirmation,
// what a window row says) are NOT here: they live in `AccountsSelectors`
// (pure, tested), and the box owns the ones that matter.
// ===========================================================================

@MainActor
final class AccountsStore: ObservableObject {

    enum Phase: Equatable {
        case idle
        case loading
        case loaded
        /// The first load failed; the message says why.
        case failed(String)
    }

    /// Which kind of label a rename targets.
    enum RenameTarget: String {
        case account
        case seat
    }

    /// Every provider with at least one seat, as of the last successful fetch.
    @Published private(set) var providers: [AccountsProvider] = []
    /// The bound conversation's seat (nil when unbound, unassigned, or unknown).
    @Published private(set) var sessionSeat: SessionSeat?
    @Published private(set) var phase: Phase = .idle
    /// A later refresh failed; the data already on screen is kept and this says
    /// why it may be stale. Cleared by the next fully successful refresh.
    @Published private(set) var refreshError: String?
    @Published private(set) var lastFetch: Date?
    /// True while a user action is in flight — mutating controls disable on it.
    @Published private(set) var acting = false
    /// The outcome of the last user action. Success clears itself; a failure
    /// stays up longer. Either can be dismissed.
    @Published private(set) var feedback: AccountsFeedback?

    let sessionId: String?

    private let api: MantaAPIClient
    private let eventStore: MantaEventStore?
    private let pollInterval: TimeInterval
    private var pollTask: Task<Void, Never>?
    private var subscriptions = Set<AnyCancellable>()
    private var started = false
    private var refreshing = false
    private var refreshQueued = false
    private var feedbackSeq = 0
    private var feedbackClear: Task<Void, Never>?

    init(api: MantaAPIClient, sessionId: String? = nil, eventStore: MantaEventStore? = nil, pollInterval: TimeInterval = 60) {
        self.api = api
        self.sessionId = sessionId
        self.eventStore = eventStore
        self.pollInterval = pollInterval
    }

    /// The bound conversation's resolved seat: the box's `session-seat` joined
    /// to the list snapshot.
    var conversationSeat: ConversationSeat? {
        AccountsSelectors.conversationSeat(providers: providers, sessionSeat: sessionSeat)
    }

    func provider(_ id: String) -> AccountsProvider? {
        providers.first { $0.provider == id }
    }

    // MARK: - Lifecycle

    /// Begin reading. Idempotent — a second call while running is a no-op.
    func start() {
        guard !started else { return }
        started = true
        if let eventStore {
            eventStore.accountsUpdates
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    Task { @MainActor in await self?.refresh() }
                }
                .store(in: &subscriptions)
            // The sink replays the current value on subscribe; `dropFirst` skips
            // that so only a genuine drop → connect transition refetches (the
            // bus event for a change made while we were away is gone).
            eventStore.$connectionState
                .dropFirst()
                .map { $0.name == "connected" }
                .removeDuplicates()
                .filter { $0 }
                .sink { [weak self] _ in
                    Task { @MainActor in await self?.refresh() }
                }
                .store(in: &subscriptions)
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                guard let interval = self?.pollInterval else { return }
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    /// Stop reading. Cancels the poll and drops the bus subscriptions so a
    /// screen can disappear without a stale task writing after teardown.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
        subscriptions.removeAll()
        feedbackClear?.cancel()
        feedbackClear = nil
        started = false
    }

    // MARK: - Reading

    /// Re-read the list (and the bound conversation's seat). Coalesces: a call
    /// that lands while a fetch is in flight queues exactly one follow-up, so a
    /// burst of bus events costs at most two round trips.
    func refresh() async {
        if refreshing {
            refreshQueued = true
            return
        }
        refreshing = true
        repeat {
            refreshQueued = false
            await fetchOnce()
        } while refreshQueued
        refreshing = false
    }

    private func fetchOnce() async {
        if phase == .idle { phase = .loading }
        var failure: String?
        do {
            let list = try await api.accountsList()
            if list != providers { providers = list }
            lastFetch = Date()
            phase = .loaded
        } catch {
            if Task.isCancelled { return }
            failure = AccountsCopy.reason(for: error)
            // A refresh that fails after a good load keeps the data on screen.
            if phase != .loaded { phase = .failed(failure ?? "") }
        }
        if let sessionId {
            do {
                let seat = try await api.accountsSessionSeat(sessionId: sessionId)
                if seat != sessionSeat { sessionSeat = seat }
            } catch {
                if Task.isCancelled { return }
                // Keep the last known seat; surface that it may be stale.
                failure = failure ?? AccountsCopy.reason(for: error)
            }
        }
        refreshError = failure
    }

    // MARK: - Actions

    /// Switch a provider between Manual and Automatic.
    func setMode(provider: String, to mode: AccountsMode) async {
        await perform("change the mode") { [api] in
            let updated = try await api.accountsSetMode(provider: provider, mode: mode)
            let name = AccountsSelectors.providerName(provider)
            return (updated, "\(name) is now \(mode == .auto ? "Automatic" : "Manual")")
        }
    }

    /// Manual mode: every conversation of the provider uses this seat from its
    /// next request. Whether to confirm first is the caller's call
    /// (`AccountsSelectors.needsResendConfirmation`).
    func useSeat(provider: String, seat: AccountsSeat) async {
        let name = seat.label.isEmpty ? "that seat" : seat.label
        await perform("switch seats") { [api] in
            let updated = try await api.accountsSetActive(provider: provider, seatId: seat.id)
            return (updated, AccountsCopy.usingSeat(name))
        }
    }

    /// Rename an account or a seat. An invalid or unchanged name is answered
    /// here, without a round trip.
    func rename(provider: String, target: RenameTarget, id: String, to raw: String, current: String) async {
        let noun = target == .account ? "account" : "seat"
        guard let label = AccountsSelectors.normalizedLabel(raw) else {
            report(AccountsCopy.failure("rename the \(noun)", reason: AccountsCopy.reason(forCode: "invalid-label")), isError: true)
            return
        }
        if label == current {
            report("The \(noun) is already named “\(label)”", isError: false)
            return
        }
        await perform("rename the \(noun)") { [api] in
            let updated = try await api.accountsRename(provider: provider, kind: target.rawValue, id: id, label: label)
            return (updated, "Renamed to “\(label)”")
        }
    }

    /// Remove a seat (never offered for the live one — the box refuses it too).
    func removeSeat(provider: String, seat: AccountsSeat) async {
        let name = seat.label.isEmpty ? "The seat" : seat.label
        await perform("remove the seat") { [api] in
            let updated = try await api.accountsRemoveSeat(provider: provider, seatId: seat.id)
            return (updated, "Removed \(name). Its conversations move to another seat on their next message.")
        }
    }

    /// Run one mutating call: single-flight, then apply the provider the box
    /// answered with and say what happened — or say why it failed.
    private func perform(
        _ action: String,
        _ work: () async throws -> (AccountsProvider, String)
    ) async {
        guard !acting else {
            report(AccountsCopy.failure(action, reason: "another change is still in progress — try again in a moment"), isError: true)
            return
        }
        acting = true
        defer { acting = false }
        do {
            let (updated, message) = try await work()
            apply(updated)
            report(message, isError: false)
        } catch {
            report(AccountsCopy.failure(action, error), isError: true)
        }
    }

    /// Replace one provider in the list with what the box just answered.
    private func apply(_ updated: AccountsProvider) {
        if let index = providers.firstIndex(where: { $0.provider == updated.provider }) {
            providers[index] = updated
        } else {
            providers.append(updated)
        }
        phase = .loaded
        // A fetch already in flight may carry the pre-change state; queue one
        // more so the screen settles on the post-change one.
        if refreshing { refreshQueued = true }
    }

    // MARK: - Feedback

    private func report(_ text: String, isError: Bool) {
        feedbackSeq += 1
        let entry = AccountsFeedback(id: feedbackSeq, text: text, isError: isError)
        feedback = entry
        feedbackClear?.cancel()
        feedbackClear = Task { [weak self] in
            try? await Task.sleep(for: .seconds(isError ? 8 : 4))
            guard !Task.isCancelled else { return }
            self?.dismissFeedback(id: entry.id)
        }
    }

    /// Clear the banner. With an id, only if that entry is still the one shown
    /// (a newer outcome must not be swept away by an older timer).
    func dismissFeedback(id: Int? = nil) {
        if let id, feedback?.id != id { return }
        feedback = nil
    }
}
