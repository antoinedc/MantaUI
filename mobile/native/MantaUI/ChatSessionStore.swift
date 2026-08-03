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
        Task {
            let messages = (try? await api.messages(sessionId: sessionId)) ?? []
            await MainActor.run {
                loading = false
                loadFailed = messages.isEmpty
                transcript = ChatTranscriptMapper.blocks(from: messages)
                rebuildBlocks()
            }
            if !isReadOnly {
                await refreshPermissions()
            }
        }
    }

    // MARK: - Stream state application

    private func applyStreamState() {
        guard let s = eventStore.sessionStates[sessionId] else { return }

        let mergedText = s.textByPart.values
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        inProgressText = mergedText

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

        // Register child stores for any subagent that has a child session id,
        // so its drill-in is live before the user taps it (BET-576).
        for payload in s.subagents {
            let childID = payload.childSessionId
            if !childID.isEmpty, childStores[childID] == nil {
                _ = ensureChildStore(childID)
            }
        }

        // Refetch the canonical transcript at turn boundaries so a finished
        // turn's blocks (steps/prose/subagents) land as real content and the
        // in-progress text is absorbed (no duplication while streaming).
        if running != lastRunning {
            lastRunning = running
            if running { scheduleRefetch() }
        }
        if turnComplete != lastComplete {
            lastComplete = turnComplete
            if turnComplete { scheduleRefetch() }
        }

        rebuildBlocks()
    }

    private func handleConnection(_ state: MantaConnectionState) {
        // A healthy reconnect means missed state should be re-fetched, exactly
        // what resyncHandler would do — but derived here so we never steal the
        // event store's single-owner resync slot from the session list.
        if state == .connected { scheduleRefetch() }
    }

    // MARK: - Block assembly

    /// The rendered transcript = canonical blocks + the live in-progress prose
    /// tail (the streaming assistant text, §8). Keeping them separate makes the
    /// scroll `defaultScrollAnchor(.bottom)` cheap: only the tail mutates
    /// between turn boundaries.
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
        let messages = (try? await api.messages(sessionId: sessionId)) ?? []
        await MainActor.run {
            transcript = ChatTranscriptMapper.blocks(from: messages)
            rebuildBlocks()
            if !isReadOnly { Task { await self.refreshPermissions() } }
        }
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
        child.start()
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

    /// §8 header subtitle ("running · 2m · 8%" / "idle").
    var headerSubtitle: String {
        let elapsed = runningSince.map { Date().timeIntervalSince($0) } ?? 0
        return ChatHeaderSubtitle.text(running: running, elapsed: elapsed, contextPct: context?.pct)
    }
}
