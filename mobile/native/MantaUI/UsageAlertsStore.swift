import Foundation
import Combine

// ===========================================================================
// WS09 F7 — usage alerts (90 % / limit) and the resume-after-limit presentation
// flag. App-wide, bound once to the app's `MantaEventStore`.
//
// The BOX owns the alerts: levels, the first-poll baseline, text, expiry, the
// reminder rule. This store only keeps the box's active set in sync
// (`UsageAlertQueue` — the hydration contract) and offers the two actions. No
// usage snapshots, no thresholds, no push (D24: in-app only).
//
// Box lifecycle: a process-wide singleton that can outlive a box switch, so it
// owns its client per box (`ModelsBoxBinding`, URL + token from one Keychain
// snapshot), drops all state on `resetForBoxChange()`, and discards any answer
// whose captured `generation` is no longer current.
// ===========================================================================

@MainActor
final class UsageAlertsStore: ObservableObject {

    static let shared = UsageAlertsStore()

    /// The alerts to show, oldest first (the banner shows the head).
    @Published private(set) var queue: [UsageAlertWire] = []
    /// The chat the user is looking at — "Remind me at reset" needs one (set by ChatScreen, M-09-5).
    @Published var activeSessionId: String?
    @Published var resumeSheetPresented = false
    /// The box predates `usage:alerts`: Insights says "Update your box to get usage alerts."
    @Published private(set) var unsupported = false
    /// A transient one-line result ("Reminder set for …"), shown by the banner.
    @Published private(set) var notice: String?

    /// For the resume sheet (F6): `usage-stopped.updated` frames and reconnects,
    /// as subjects because the raw-frame handler list cannot unsubscribe.
    let stoppedUpdates = PassthroughSubject<Void, Never>()
    let reconnects = PassthroughSubject<Void, Never>()

    static let warnLifetimeSeconds: Double = 6

    private let fixedClient: MantaAPIClient?
    private let credentials: @MainActor () -> ModelsBoxCredentials?
    private let makeClient: (ModelsBoxBinding) -> MantaAPIClient
    private let sleep: @Sendable (Double) async -> Void
    private var api: MantaAPIClient?
    private(set) var binding: ModelsBoxBinding?
    private var generation = 0
    private var state = UsageAlertQueue()
    private var hydrationTask: Task<Void, Never>?
    private var warnTimers: [String: Task<Void, Never>] = [:]
    private var noticeTask: Task<Void, Never>?
    private var boundEventStore = false
    private var cancellables: Set<AnyCancellable> = []
    // Only written in init and read in deinit; NSObjectProtocol tokens are not Sendable.
    nonisolated(unsafe) private var removedObserver: NSObjectProtocol?

    init(
        api: MantaAPIClient? = nil,
        credentials: @escaping @MainActor () -> ModelsBoxCredentials? = ChatModelCatalog.keychainCredentials,
        makeClient: @escaping (ModelsBoxBinding) -> MantaAPIClient = ChatModelCatalog.liveClient,
        sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.fixedClient = api
        self.credentials = credentials
        self.makeClient = makeClient
        self.sleep = sleep
        removedObserver = NotificationCenter.default.addObserver(
            forName: .mantaBoxRemoved, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.resetForBoxChange() }
        }
    }

    deinit {
        if let removedObserver { NotificationCenter.default.removeObserver(removedObserver) }
    }

    // MARK: - Binding

    /// Idempotent. Registers ONE raw-frame handler (`usage.alert`,
    /// `usage-stopped.updated`) and a retained connection-state subscription; on the
    /// first `.connected` and every disconnect→connect it re-hydrates from
    /// `usage:alerts`. Also subscribes the model catalogue to its bus frames, so one
    /// call at the app root binds all of WS09's app-wide state.
    func bind(eventStore: MantaEventStore) {
        guard !boundEventStore else { return }
        boundEventStore = true
        ChatModelCatalog.shared.subscribe(to: eventStore)
        eventStore.addRawFrameHandler { [weak self] frame in
            self?.handle(frame: frame)
        }
        eventStore.$connectionState
            .map { $0.name == "connected" }
            .removeDuplicates()
            .filter { $0 }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.reconnects.send()
                self?.beginHydration()
            }
            .store(in: &cancellables)
    }

    func handle(frame: MantaStreamFrame) {
        switch frame.kind {
        case "usage.alert":
            guard let payload = try? frame.decodedPayload(UsageAlertFrame.self) else {
                // A frame we cannot read is a missed change: re-read the box's set.
                beginHydration()
                return
            }
            apply(state.applyFrame(payload))
        case "usage-stopped.updated":
            stoppedUpdates.send()
        default:
            break
        }
    }

    // MARK: - Hydration

    /// New epoch + a `usage:alerts` request tagged with it (retried on 1 s / 2 s /
    /// 5 s, then every 30 s, until it lands or a newer epoch supersedes it).
    func beginHydration() {
        let epoch = state.startHydration()
        requestSnapshot(epoch: epoch, attempt: 0)
    }

    private func requestSnapshot(epoch: Int, attempt: Int) {
        hydrationTask?.cancel()
        guard let client = currentClient() else { return }
        let gen = generation
        hydrationTask = Task { [weak self] in
            do {
                let list = try await client.usageAlerts()
                self?.receive(list, epoch: epoch, generation: gen)
            } catch {
                guard let self, !Task.isCancelled, gen == self.generation else { return }
                if BoxCapabilities.isUnknownChannel(error) {
                    self.unsupported = true
                    return
                }
                await self.sleep(UsageAlertsRetry.delaySeconds(attempt: attempt))
                guard !Task.isCancelled, gen == self.generation else { return }
                let next = self.state.startHydration()
                self.requestSnapshot(epoch: next, attempt: attempt + 1)
            }
        }
    }

    private func receive(_ list: UsageAlertsList, epoch: Int, generation gen: Int) {
        guard gen == generation else { return }
        unsupported = false
        apply(state.applySnapshot(list, epoch: epoch))
    }

    private func apply(_ action: UsageAlertQueue.Action) {
        publishQueue()
        if action == .hydrate { beginHydration() }
    }

    private func publishQueue() {
        queue = state.visible
        // A warn alert leaves 6 s after it is first shown; limit alerts stay until
        // closed or retired by the box.
        let live = Set(queue.map(\.id))
        for id in warnTimers.keys where !live.contains(id) {
            warnTimers[id]?.cancel()
            warnTimers[id] = nil
        }
        if let head = queue.first, !head.sticky, warnTimers[head.id] == nil {
            let id = head.id
            warnTimers[id] = Task { [weak self] in
                guard let self else { return }
                await self.sleep(Self.warnLifetimeSeconds)
                guard !Task.isCancelled else { return }
                self.dismiss(id: id)
            }
        }
    }

    // MARK: - Actions

    /// Close a banner: it leaves the queue; its id stays "seen" so it never re-shows.
    func dismiss(id: String) {
        state.dismiss(id)
        warnTimers[id]?.cancel()
        warnTimers[id] = nil
        publishQueue()
    }

    /// "Remind me at reset": the BOX resolves the current reset instant and refuses an
    /// elapsed one. Needs an open chat (`activeSessionId`). Always ends in a message.
    func remindAtReset(_ alert: UsageAlertWire) async {
        guard alert.canRemind else { return }
        guard let sessionID = activeSessionId else {
            show("Open a chat to set a reminder.")
            return
        }
        guard let client = currentClient() else { return }
        let gen = generation
        do {
            let reply = try await client.usageRemindAtReset(key: alert.key, sessionID: sessionID)
            guard gen == generation else { return }
            if reply.ok {
                if let fireAt = reply.fireAt {
                    show("Reminder set for \(UsageMeters.resetAt(Date(timeIntervalSince1970: fireAt / 1000), now: Date())).")
                } else {
                    show("Reminder set.")
                }
                dismiss(id: alert.id)
            } else {
                show(reply.message ?? "Couldn't set a reminder.")
                if reply.code == "expired" { dismiss(id: alert.id) }
            }
        } catch {
            guard gen == generation else { return }
            show("Couldn't set a reminder: \(ModelsCapability.reason(error))")
        }
    }

    /// "Keep going at reset" opens the resume sheet (F6).
    func keepGoing(_ alert: UsageAlertWire) {
        guard alert.canKeepGoing else { return }
        presentResume()
    }

    func presentResume() {
        resumeSheetPresented = true
    }

    /// A one-line result from another screen (the resume sheet), shown by the banner.
    func showNotice(_ text: String) {
        show(text)
    }

    private func show(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            guard let self else { return }
            await self.sleep(4)
            guard !Task.isCancelled else { return }
            self.notice = nil
        }
    }

    // MARK: - Box lifecycle

    /// Drop everything from the previous box. Nothing is fetched until the new box's
    /// stream connects (the bound connection-state subscription re-hydrates then).
    func resetForBoxChange() {
        generation += 1
        hydrationTask?.cancel()
        hydrationTask = nil
        for timer in warnTimers.values { timer.cancel() }
        warnTimers = [:]
        noticeTask?.cancel()
        noticeTask = nil
        state.reset()
        queue = []
        activeSessionId = nil
        resumeSheetPresented = false
        unsupported = false
        notice = nil
        api = nil
        binding = nil
    }

    private func currentClient() -> MantaAPIClient? {
        if let fixedClient { return fixedClient }
        switch ModelsBoxBinding.resolve(current: binding, credentials: credentials()) {
        case .unpaired:
            return nil
        case .same:
            if let api { return api }
            guard let binding else { return nil }
            let client = makeClient(binding)
            api = client
            return client
        case .rebind(let next, let boxChanged):
            // The first bind (no previous binding) has nothing to drop — resetting
            // there would erase `activeSessionId` / a raced `presentResume()`. A box
            // switch or removal already ran `resetForBoxChange()` and cleared the binding.
            if boxChanged && binding != nil { resetForBoxChange() }
            binding = next
            let client = makeClient(next)
            api = client
            return client
        }
    }
}
