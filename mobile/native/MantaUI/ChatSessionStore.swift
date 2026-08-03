import Foundation
import Combine

// ===========================================================================
// S4 — chat session store (BET-596).
//
// The live, observable session store the chat screen binds to, replacing the
// hardcoded `parentBlocks` fixture. It is fed from two sources:
//
//   1. The canonical `opencode:messages` transcript — the persisted source of
//      `.user` / completed `.prose` / `.steps` / subagent rows. Refetched at
//      each turn boundary so a finished turn's blocks land as real content.
//   2. The S1b `/events` stream state (MantaEventStore.sessionStates[sessionId])
//      — already interpreted by the box (§17): the running assistant text
//      (`stream:flush`), running/turnComplete, context/tokens, todos,
//      truncation, questions, and live subagent status.
//
// Permissions are fetched via `opencode:permissions` and lightly polled while
// the screen is active; questions arrive on the interpreted stream. Both are
// answerable from the phone (S1a reply/reject RPCs). Parent and children are
// each their own store; a child store is read-only (no permission poll) —
// §8a v1.
//
// Deliberately does NOT touch the event store's single-owner `rawFrameHandler`
// or `resyncHandler`; resync + attention are derived from the @Published stream
// state and a connectionState transition instead, so the session list's
// handlers (owned by SessionListStore) are never clobbered.
// ===========================================================================

@MainActor
final class ChatSessionStore: ObservableObject {

    @Published private(set) var transcript: [TranscriptBlock] = []
    @Published private(set) var inProgressText = ""
    @Published private(set) var blocks: [TranscriptBlock] = []
    @Published private(set) var running = false
    @Published private(set) var turnComplete = false
    @Published private(set) var context: StreamContextPayload?
    @Published private(set) var cache: StreamCachePayload?
    @Published private(set) var truncation: StreamTruncationPayload?
    @Published private(set) var todos: StreamTodosPayload?
    @Published private(set) var questions: [QuestionRequest] = []
    @Published private(set) var permissions: [PermissionRequest] = []
    @Published private(set) var subagents: [StreamSubagentPayload] = []
    @Published private(set) var childStores: [String: ChatSessionStore] = [:]
    @Published private(set) var loading = false
    @Published private(set) var loadFailed = false
    /// True while a canonical transcript refetch (or the initial load) is in
    /// flight. Drives the ambient hairline sweep on the composer's top divider
    /// (BET-630, D1) — distinct from `running`, which drives the working row.
    @Published private(set) var refreshing = false
    /// True when the transcript on screen is a WINDOW onto a longer history —
    /// i.e. the box returned a full page, so older messages exist. Drives the
    /// "Load earlier messages" affordance at the top of the transcript.
    @Published private(set) var hasEarlier = false
    /// True while a `loadEarlier()` widening fetch is in flight.
    @Published private(set) var loadingEarlier = false

    /// How many of the most recent messages the first fetch asks for. A session
    /// open used to pull the ENTIRE history — hundreds of KB on a long session,
    /// almost all of it scrolled far out of view. One screenful is ~3-6 blocks,
    /// so 30 messages is several screens of headroom.
    static let initialMessageLimit = 30
    /// Each "load earlier" tap widens the window by this much. opencode has no
    /// working cursor on this endpoint (`before` is declared but 400s), so
    /// paging = re-asking for a bigger tail. Wasteful in principle, bounded and
    /// simple in practice — and it only happens when the user asks for it.
    static let earlierMessageStep = 50

    let sessionId: String
    let isReadOnly: Bool

    private let api: MantaAPIClient
    private let eventStore: MantaEventStore
    private var cancellables: Set<AnyCancellable> = []
    private var permissionPoll: Timer?
    private var runningSince: Date?
    private var didRunOnce = false
    private var lastRunning: Bool?
    private var lastComplete: Bool?
    /// How many recent messages the CURRENT window covers. Every refetch reuses
    /// it, so a turn-boundary refresh never silently collapses a window the
    /// user widened.
    private var messageLimit = ChatSessionStore.initialMessageLimit
    /// One transcript fetch at a time. Three independent triggers (first load,
    /// connection, turn boundary) used to fire concurrently on open and pull the
    /// same transcript three times over. `fetchPending` remembers that a trigger
    /// arrived mid-flight so the refresh still happens — exactly once — after.
    private var fetchInFlight = false
    private var fetchPending = false
    /// The connection sink replays its CURRENT value on subscribe, so without
    /// this the store fired a "reconnect" refetch before `start()` had even run.
    /// Only a genuine drop→connect transition is a resync.
    private var wasConnected: Bool?

    init(
        sessionId: String,
        eventStore: MantaEventStore,
        api: MantaAPIClient,
        isReadOnly: Bool = false
    ) {
        self.sessionId = sessionId
        self.eventStore = eventStore
        self.api = api
        self.isReadOnly = isReadOnly

        eventStore.$sessionStates
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.applyStreamState() }
            .store(in: &cancellables)

        eventStore.$connectionState
            .receive(on: RunLoop.main)
            .sink { [weak self] state in self?.handleConnection(state) }
            .store(in: &cancellables)
    }

    // MARK: - Lifecycle

    /// Begin loading the session and (for the parent) start the light
    /// permission poll. Idempotent.
    func start() {
        guard !didRunOnce else { return }
        didRunOnce = true
        load()
        if !isReadOnly {
            startPermissionPoll()
        }
    }

    func stop() {
        permissionPoll?.invalidate()
        permissionPoll = nil
    }

    func load() {
        guard !loading else { return }
        loading = true
        refreshing = true
        Task {
            await fetchTranscript(isFirstLoad: true)
            // Cleared HERE, not inside the fetch: the fetch can return early
            // (a refetch already in flight serves this load), and every one of
            // those paths must still take the screen off its skeleton.
            await MainActor.run { loading = false }
            if !isReadOnly {
                await refreshPermissions()
            }
        }
    }

    /// Widen the window by `earlierMessageStep` and re-render. No-op while a
    /// widening is already running or when the whole history is already shown.
    func loadEarlier() {
        guard hasEarlier, !loadingEarlier else { return }
        loadingEarlier = true
        messageLimit += ChatSessionStore.earlierMessageStep
        Task {
            await fetchTranscript(isFirstLoad: false)
            await MainActor.run { loadingEarlier = false }
        }
    }

    /// Run `work`, failing if it has not finished within `seconds`.
    private static func withTimeout<T: Sendable>(
        seconds: Double,
        _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw MantaError.transport("timed out")
            }
            guard let first = try await group.next() else {
                throw MantaError.transport("no result")
            }
            group.cancelAll()
            return first
        }
    }

    // MARK: - Stream state application

    private func applyStreamState() {
        guard let s = eventStore.sessionStates[sessionId] else { return }

        inProgressText = s.liveText

        running = s.running == true
        turnComplete = s.turnComplete == true
        context = s.context
        cache = s.cache
        truncation = s.truncation
        todos = s.todos
        questions = s.questions?.questions ?? []
        subagents = s.subagents

        // Track running-this-turn for the header timer.
        if running && runningSince == nil {
            runningSince = Date()
        } else if !running {
            runningSince = nil
        }

        // Register a store for any subagent that has a child session id, so the
        // drill-in destination can resolve it without mutating state during a
        // view update (BET-576). Registering does NOT start it: the child's own
        // screen calls `start()` on appear. Starting them here meant opening a
        // parent session downloaded a full extra transcript for EVERY subagent
        // in its history, none of which is on screen.
        for payload in s.subagents {
            let childID = payload.childSessionId
            if !childID.isEmpty, childStores[childID] == nil {
                _ = ensureChildStore(childID)
            }
        }

        // Refetch the canonical transcript at turn boundaries so a finished
        // turn's blocks (steps/prose/subagents) land as real content. The fetch
        // itself retires the live text it now covers (see `fetchTranscript`) —
        // absorption is an explicit step, not something the refetch does for
        // free. Assuming it was free is what rendered every finished answer
        // twice (BET-655).
        //
        // The FIRST call here is not a transition, it is the initial snapshot:
        // `@Published` replays its current value the moment we subscribe, which
        // is before `start()` runs. Seeding without fetching is what stops a
        // session open from pulling the same transcript two extra times.
        let firstSnapshot = lastRunning == nil && lastComplete == nil
        let runningChanged = running != lastRunning
        let completeChanged = turnComplete != lastComplete
        lastRunning = running
        lastComplete = turnComplete
        if !firstSnapshot {
            if runningChanged && running { scheduleRefetch() }
            if completeChanged && turnComplete { scheduleRefetch() }
        }

        rebuildBlocks()
    }

    private func handleConnection(_ state: MantaConnectionState) {
        // A healthy RECONNECT means missed state should be re-fetched, exactly
        // what resyncHandler would do — but derived here so we never steal the
        // event store's single-owner resync slot from the session list.
        //
        // Only a drop→connect transition counts. The sink replays the current
        // value on subscribe, so treating every `.connected` as a resync fired
        // a full transcript fetch at construction, racing the one `start()` was
        // about to make.
        let connected = state == .connected
        let wasDisconnected = wasConnected == false
        wasConnected = connected
        if connected && wasDisconnected { scheduleRefetch() }
    }

    // MARK: - Block assembly

    /// The rendered transcript = canonical blocks + the live in-progress prose
    /// tail (the streaming assistant text, §8). Keeping them separate makes the
    /// scroll `defaultScrollAnchor(.bottom)` cheap: only the tail mutates
    /// between turn boundaries.
    ///
    /// The two sources must never hold the same prose at once — that is a
    /// visible duplicate, not a harmless overlap. The tail is emptied by the
    /// retirement step in `fetchTranscript`; nothing else may append to it.
    private func rebuildBlocks() {
        if inProgressText.isEmpty {
            blocks = transcript
        } else {
            blocks = transcript + [.prose(inProgressText)]
        }
    }

    // MARK: - Refetch

    private func scheduleRefetch() {
        Task { await refetch() }
    }

    func refetch() async {
        await fetchTranscript(isFirstLoad: false)
        if !isReadOnly { await refreshPermissions() }
    }

    /// The ONE place a transcript is fetched. Serialised: a trigger that
    /// arrives while a fetch is running sets `fetchPending` instead of starting
    /// a second identical request, and the in-flight one re-runs once when it
    /// finishes so nothing is missed.
    ///
    /// An EMPTY transcript is not a failure — a session you just cleared
    /// legitimately has no messages, and reporting that as "couldn't reach your
    /// box" was wrong. Only a thrown error is. The fetch is also bounded: an
    /// unreachable box can hang a request for the URLSession default (a minute
    /// or more), leaving the screen on its skeleton with no way out.
    private func fetchTranscript(isFirstLoad: Bool) async {
        if fetchInFlight {
            fetchPending = true
            return
        }
        fetchInFlight = true
        defer { fetchInFlight = false }

        repeat {
            fetchPending = false
            refreshing = true
            let limit = messageLimit
            var failed = false
            var messages: [OpencodeMessage] = []
            do {
                messages = try await Self.withTimeout(seconds: 12) {
                    try await self.api.messages(sessionId: self.sessionId, limit: limit, slim: true)
                }
            } catch {
                failed = true
            }
            let loaded = messages
            let didFail = failed
            await MainActor.run {
                if isFirstLoad { loadFailed = didFail }
                refreshing = false
                // A full page back means the window is a view onto more
                // history. A short page means we are looking at all of it. A
                // failed fetch says nothing either way — leave it alone.
                if !didFail { hasEarlier = loaded.count >= limit }
                if !didFail || isFirstLoad {
                    transcript = ChatTranscriptMapper.blocks(from: loaded)
                    // The transcript now carries these messages, so any live
                    // copy of them is a duplicate — retire it BEFORE rebuilding
                    // or the finished answer renders twice, once from each
                    // source (BET-655). Read the pruned text back synchronously:
                    // the event-store sink lands on a later run-loop turn, too
                    // late for the rebuild happening right here.
                    if !didFail {
                        eventStore.retireCoveredStreamText(
                            sessionId: sessionId,
                            covered: Set(loaded.map(\.info.id))
                        )
                        inProgressText = eventStore.sessionStates[sessionId]?.liveText ?? ""
                    }
                    rebuildBlocks()
                }
            }
        } while fetchPending
    }

    // MARK: - Permissions (S1a answerable)

    private func startPermissionPoll() {
        let timer = Timer(timeInterval: 2.5, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshPermissions() }
        }
        RunLoop.main.add(timer, forMode: .common)
        permissionPoll = timer
    }

    func refreshPermissions() async {
        let perms = (try? await api.permissions(sessionId: sessionId)) ?? []
        await MainActor.run { permissions = perms }
    }

    // MARK: - Answers (wire from the phone, S1a)

    func replyPermission(_ request: PermissionRequest, reply: PermissionReply) {
        Task {
            try? await api.permissionReply(requestId: request.id, reply: reply, sessionId: sessionId)
            await refreshPermissions()
        }
    }

    func replyQuestion(_ request: QuestionRequest, answers: [[String]]) {
        Task {
            try? await api.questionReply(requestId: request.id, answers: answers, sessionId: sessionId)
        }
    }

    func rejectQuestion(_ request: QuestionRequest) {
        Task {
            try? await api.questionReject(requestId: request.id, sessionId: sessionId)
        }
    }

    // MARK: - Composer (S5 / BET-597)

    /// Send a prompt for this session. `text` needs no trimming here (the
    /// composer trims); attachments + model are optional and flow through the
    /// unchanged `opencode:prompt` surface.
    func send(text: String, attachments: [SendPromptInput.Attachment], model: SendPromptInput.Model?) {
        // Echo the message straight into the transcript and assume the turn is
        // running. The box confirms both within a second (running frame, then
        // the canonical refetch replaces this block), but without the echo the
        // screen sits completely unchanged after a send, which reads as "the
        // send did nothing".
        if !text.isEmpty {
            transcript.append(.user(text))
            rebuildBlocks()
        }
        running = true
        turnComplete = false
        if runningSince == nil { runningSince = Date() }
        Task {
            try? await api.sendPrompt(SendPromptInput(
                sessionId: sessionId,
                text: text,
                model: model,
                attachments: attachments.isEmpty ? nil : attachments
            ))
        }
    }

    /// Interrupt the running turn (voice `abort`).
    func abort() {
        Task { try? await api.abort(sessionId: sessionId) }
    }

    /// Compact the session to free context (voice `compact`).
    func compact() {
        Task { try? await api.compactSession(sessionId: sessionId) }
    }

    /// Dispatch a store-level voice action. Returns a human hint string when
    /// the action was NOT handled here (the caller should surface it), or nil
    /// when it was handled. Actions that insert/modify composer text
    /// (`submit`/`append`/`unknown`) and the app-level ones (`newSession`,
    /// `openSettings`, `switchWindow`, `fork`, `clear`, `help`,
    /// `toggleTrust`) are NOT this store's job — the composer routes those.
    @discardableResult
    func dispatchVoice(_ action: VoiceAction) -> String? {
        switch action {
        case .allowOnce:
            replyToLatestPermission(.once)
            return nil
        case .allowAlways:
            replyToLatestPermission(.always)
            return nil
        case .reject:
            if newestPermission != nil {
                replyToLatestPermission(.reject)
            } else if newestQuestion != nil {
                rejectQuestion(newestQuestion!)
            }
            return nil
        case .answer(let choice):
            return answerLatestQuestion(choice: choice)
        case .abort:
            abort()
            return nil
        case .compact:
            compact()
            return nil
        default:
            return ChatVoiceHint.text(for: action)
        }
    }

    private func replyToLatestPermission(_ reply: PermissionReply) {
        guard let permission = newestPermission else { return }
        replyPermission(permission, reply: reply)
    }

    /// Answer the newest pending question from a spoken `choice`: a bare
    /// "yes"/"no" token, a numbered option (1..n), or an option label / free
    /// text. Returns a hint (non-nil) when no question is pending — the caller
    /// surfaces it; nil when answered.
    private func answerLatestQuestion(choice: String) -> String? {
        guard let question = newestQuestion, let first = question.questions.first else {
            return "No question waiting"
        }
        let trimmed = choice.trimmingCharacters(in: .whitespacesAndNewlines)
        let optionIndex: Int?
        if let asNumber = Int(trimmed), asNumber >= 1, asNumber <= first.options.count {
            optionIndex = asNumber - 1
        } else if let labelIndex = first.options.firstIndex(where: {
            $0.label.compare(trimmed, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }) {
            optionIndex = labelIndex
        } else {
            optionIndex = nil
        }
        var answers = [[String]]()
        for (index, q) in question.questions.enumerated() {
            if let optionIndex, q.options.indices.contains(optionIndex) {
                answers.append([q.options[optionIndex].label])
            } else if index == 0 {
                // Free-form answer applies to the spoken question (the first).
                answers.append([trimmed])
            } else {
                answers.append([])
            }
        }
        replyQuestion(question, answers: answers)
        return nil
    }

    // MARK: - Subagent drill-in (BET-576)

    func ensureChildStore(_ childSessionId: String) -> ChatSessionStore {
        if let existing = childStores[childSessionId] {
            return existing
        }
        let child = ChatSessionStore(
            sessionId: childSessionId,
            eventStore: eventStore,
            api: api,
            isReadOnly: true
        )
        childStores[childSessionId] = child
        // NOT started here — `ChatSubagentScreen.onAppear` calls `start()`, so
        // a child's transcript is fetched when the user opens it and not
        // before. See the registration comment in `applyStreamState`.
        return child
    }

    func store(for childSessionId: String?) -> ChatSessionStore? {
        guard let childSessionId else { return nil }
        return ensureChildStore(childSessionId)
    }

    // MARK: - Header

    /// The newest pending permission, if any (used by the composer's voice
    /// answer routing + the bottom cards).
    var newestPermission: PermissionRequest? { permissions.last }

    /// The newest pending question request, if any.
    var newestQuestion: QuestionRequest? { questions.last }

    /// When the current turn started (nil when idle). The running row measures
    /// live elapsed against its own 1s tick rather than stream-state changes
    /// (BET-630, D1).
    var runningStart: Date? { runningSince }

    /// §8 header subtitle ("running · 2m · 8%" / "idle").
    var headerSubtitle: String {
        let elapsed = runningSince.map { Date().timeIntervalSince($0) } ?? 0
        return ChatHeaderSubtitle.text(running: running, elapsed: elapsed, contextPct: context?.pct)
    }
}
