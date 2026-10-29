import Foundation
import Combine

// ===========================================================================
// WS02 F6 — is this session a read-only background job?
//
// The BOX decides (`delegate:job-for-session`): job-ness, the bar's three lines,
// whether it can be stopped, where the parent window is. This store only holds
// the connection-state machine around that question (`ChatCardMutationPolicy`):
//
//   .resolving → the box has not answered. Typing stays possible, sends are held
//                (never delivered), blocking cards are inert.
//   .allowed   → ordinary session.
//   .readOnlyJob → the composer is replaced by the bar.
//
// ANY failure keeps the current state; only a SUCCESSFUL answer changes it (so a
// held message is never released into a job session on a hiccup). An older box
// (no `chat-cards-1`) resolves to `.allowed` with `jobBarUnavailable` — there is
// no bar to show and no refusal either: exactly the behaviour before.
// ===========================================================================

@MainActor
final class ChatCardJobOwnershipStore: ObservableObject {
    /// Non-nil only for a read-only job: the bar's content.
    @Published private(set) var job: ChatCardJobView?
    @Published private(set) var policy: ChatCardMutationPolicy = .resolving
    @Published private(set) var stopping = false
    /// Why the last resolve / stop failed (shown with a Retry while resolving).
    @Published private(set) var lastFailure: String?
    @Published private(set) var jobBarUnavailable = false
    @Published private(set) var resolveInFlight = false

    /// Pushed in the same main-actor step that publishes `job`, so the chat store's
    /// policy and the bar never disagree.
    var onPolicy: ((ChatCardMutationPolicy) -> Void)?
    var onHint: ((String) -> Void)?

    private let sessionId: String
    private let api: any ChatCardJobAPI
    private let capabilities: BoxCapabilitiesStore
    private var capabilityWatch: AnyCancellable?

    init(sessionId: String, api: any ChatCardJobAPI, capabilities: BoxCapabilitiesStore) {
        self.sessionId = sessionId
        self.api = api
        self.capabilities = capabilities
        // Belt and braces: when the capability list lands while this session is still
        // unconfirmed, ask again at once rather than waiting for the 30 s tick.
        capabilityWatch = capabilities.$state
            .dropFirst()
            .compactMap { $0.known }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.policy == .resolving else { return }
                    await self.resolve()
                }
            }
    }

    /// Whether the 30 s re-resolve should be running: while still resolving, or
    /// while the bar shows a running job (recovers a missed `delegate.updated`).
    var needsPolling: Bool {
        policy == .resolving || job?.stoppable == true
    }

    /// Ask the box. Safe to call from any trigger (appear, `delegate.updated`,
    /// reconnect, foreground, the 30 s tick, the Retry button).
    func resolve() async {
        guard !resolveInFlight else { return }
        resolveInFlight = true
        defer { resolveInFlight = false }

        if capabilities.has(.chatCards) == nil {
            await capabilities.refresh()
        }
        let input: ChatCardOwnershipInput
        switch capabilities.has(.chatCards) {
        case .none:
            lastFailure = "Can't confirm this session yet — messages you send will wait"
            input = .failure
        case .some(false):
            lastFailure = nil
            input = .capabilityAbsent
        case .some(true):
            do {
                input = .answer(try await api.delegateJobForSession(sessionId: sessionId))
                lastFailure = nil
            } catch {
                NSLog("[chat-cards] job lookup failed for %@: %@", sessionId, String(describing: error))
                lastFailure = "Can't confirm this session yet — messages you send will wait"
                input = .failure
            }
        }
        let verdict = ChatCardOwnershipResolver.next(current: policy, currentJob: job, result: input)
        jobBarUnavailable = verdict.jobBarUnavailable
        if job != verdict.job { job = verdict.job }
        if policy != verdict.policy { policy = verdict.policy }
        onPolicy?(verdict.policy)
    }

    /// Stop the job (the view has already confirmed). Success and failure are both
    /// reported; either way the box is asked again.
    func stop() async {
        guard let job, job.stoppable, !stopping else { return }
        stopping = true
        defer { stopping = false }
        do {
            try await api.delegateStop(id: job.id)
            onHint?("Job stopped")
        } catch {
            onHint?("Couldn't stop the job: \(BackgroundJobFormat.failureReason(error))")
        }
        await resolve()
    }
}
