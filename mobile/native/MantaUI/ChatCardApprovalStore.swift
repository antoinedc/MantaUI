import Foundation
import Combine

// ===========================================================================
// WS02 F5 — the background-job approval card's store.
//
// A `delegate` call with declared tools (trust mode off) waits for the user's
// go-ahead: Start job / Edit access / Not now. This store owns the ONE pending
// approval of a chat. Rules that matter:
//
//   - NO auto-approval of any kind. (The desktop auto-approves when the parent's
//     pending permissions' `always[]` cover the tools — but `always` on a PENDING
//     ask is what WOULD be saved, not a grant. Reported, not ported.)
//   - An id decided on this device is tombstoned: an in-flight poll that returns
//     after the decision cannot bring the card back.
//   - `ok:false` WITH an error = the box refused the rules → the card stays and
//     says why. `ok:false` without = no longer pending (decided elsewhere or
//     expired) → the card goes, with a hint.
//   - Nothing is swallowed: a transport failure keeps the card and says so.
// ===========================================================================

@MainActor
final class ChatCardApprovalStore: ObservableObject {
    @Published private(set) var pending: ChatCardApproval?
    @Published private(set) var busy = false
    @Published private(set) var error: String?

    /// Where a one-line confirmation goes (the chat's action hint).
    var onHint: ((String) -> Void)?

    private let sessionId: String
    private let api: any ChatCardApprovalAPI
    private var resolvedIDs: Set<String> = []
    private var pollTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []

    static let pollInterval: UInt64 = 3_000_000_000

    init(sessionId: String, api: any ChatCardApprovalAPI,
         requests: AnyPublisher<ChatCardApproval, Never> = Empty<ChatCardApproval, Never>().eraseToAnyPublisher()) {
        self.sessionId = sessionId
        self.api = api
        requests
            .receive(on: DispatchQueue.main)
            .sink { [weak self] approval in self?.received(approval) }
            .store(in: &cancellables)
    }

    // MARK: - Reading

    /// A pushed `delegate.approval.requested` frame (not session-enveloped, so
    /// filtered on the parent id here).
    func received(_ approval: ChatCardApproval) {
        guard approval.parentSessionID == sessionId else { return }
        apply([approval])
    }

    /// Ask the box. A failure keeps the card that is showing and is logged — it is
    /// ambient, and the next tick or frame repairs it.
    func refresh() async {
        do {
            let list = try await api.delegatePendingApprovals(sessionId: sessionId)
            applyAuthoritative(list)
        } catch {
            NSLog("[chat-cards] couldn't read pending approvals for %@: %@", sessionId, String(describing: error))
        }
    }

    private func apply(_ list: [ChatCardApproval]) {
        let visible = ChatCardApprovalLogic.filterResolved(list, resolved: resolvedIDs)
        guard let first = visible.first else {
            // Pushed frames carry one approval, never "the whole list": only an
            // authoritative list (the poll) may remove the card.
            return
        }
        if pending?.id != first.id { error = nil }
        if pending != first { pending = first }
    }

    /// Replace the card with the box's authoritative list (the poll's answer).
    private func applyAuthoritative(_ list: [ChatCardApproval]) {
        let visible = ChatCardApprovalLogic.filterResolved(list, resolved: resolvedIDs)
        if let first = visible.first {
            apply([first])
        } else if pending != nil {
            pending = nil
            error = nil
        }
    }

    /// Poll every 3 s while `active` (the chat is visible AND a turn is running);
    /// stop when it is not. The pushed frame covers the common case — the poll is
    /// the safety net for a missed one.
    func setPolling(_ active: Bool) {
        if active {
            guard pollTask == nil else { return }
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.pollOnce()
                    try? await Task.sleep(nanoseconds: Self.pollInterval)
                }
            }
        } else {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private func pollOnce() async {
        do {
            let list = try await api.delegatePendingApprovals(sessionId: sessionId)
            applyAuthoritative(list)
        } catch {
            NSLog("[chat-cards] approval poll failed for %@: %@", sessionId, String(describing: error))
        }
    }

    /// Stop everything (the screen is leaving) — there is no `deinit` hook for
    /// the poll, so the screen must call this.
    func stop() {
        setPolling(false)
    }

    // MARK: - Deciding

    func approve(tools: [ChatCardApprovalTool]) async {
        guard let approval = pending, !busy else { return }
        // Start is disabled for these in the card; refuse here too so no RPC is
        // ever sent with an empty or blank rule.
        guard ChatCardApprovalLogic.canStart(tools: tools) else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result = try await api.delegateApprove(id: approval.id, tools: tools)
            if result.ok {
                finish(approval.id, hint: ChatCardApprovalLogic.outcomeHint(ok: true, approved: true))
            } else if let refusal = result.error {
                // The box refused the rules: the approval is still pending.
                error = refusal
            } else {
                finish(approval.id, hint: ChatCardApprovalLogic.outcomeHint(ok: false, approved: true))
                await refresh()
            }
        } catch {
            self.error = ChatCardApprovalLogic.unreachable
        }
    }

    func decline() async {
        guard let approval = pending, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let ok = try await api.delegateDecline(id: approval.id)
            finish(approval.id, hint: ChatCardApprovalLogic.outcomeHint(ok: ok, approved: false))
            if !ok { await refresh() }
        } catch {
            self.error = ChatCardApprovalLogic.unreachable
        }
    }

    private func finish(_ id: String, hint: String) {
        resolvedIDs.insert(id)
        pending = nil
        onHint?(hint)
    }
}
