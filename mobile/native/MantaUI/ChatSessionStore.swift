import Foundation
import Combine
import MessagingUI

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
// Permissions and questions both arrive on the interpreted stream (`sub:
// "permissions"` / `sub: "questions"`); `opencode:permissions` is only the
// seed/resync path (the 2.5s poll is gone). Both are answerable from the phone
// (S1a reply/reject RPCs). Parent and children are each their own store; a
// child store is read-only (§8a v1).
//
// Deliberately does NOT touch the event store's single-owner `rawFrameHandler`
// or `resyncHandler`; resync + attention are derived from the @Published stream
// state and a connectionState transition instead, so the session list's
// handlers (owned by SessionListStore) are never clobbered.
// ===========================================================================

// ===========================================================================
// Single-writer stream merge (BET-668).
//
// The chat screen has TWO writers for the same turn state — the optimistic
// LOCAL updates (`send()`, `replyQuestion`/`rejectQuestion`) and the incoming
// interpreted-stream frames — and the stream frame used to unconditionally
// clobber the optimistic value. All the merge decisions below are PURE so
// they are unit-testable; the store applies the returned state.
// ===========================================================================

/// The subset of turn state the stream-merge decisions own.
struct ChatStreamTurnState: Equatable {
    var running: Bool
    var turnComplete: Bool
    var streamingTailID: String
    var locallyAnsweredQuestionIDs: Set<String>
    var questions: [QuestionRequest]

    init(
        running: Bool = false,
        turnComplete: Bool = false,
        streamingTailID: String = "",
        locallyAnsweredQuestionIDs: Set<String> = [],
        questions: [QuestionRequest] = []
    ) {
        self.running = running
        self.turnComplete = turnComplete
        self.streamingTailID = streamingTailID
        self.locallyAnsweredQuestionIDs = locallyAnsweredQuestionIDs
        self.questions = questions
    }
}

enum ChatStreamMerge {
    /// Apply the per-frame lifecycle facts of one interpreted-stream frame to
    /// the turn state.
    ///
    /// - `frameTurnComplete`: non-nil ONLY when THIS frame carried a completion
    ///   flag (a genuine `turnComplete` frame). This is the only thing that
    ///   resets the streaming tail — never a bare `running == false` write and
    ///   never a STALE accumulated completion left over from a previous turn.
    /// - `frameStartedRunning`: true when THIS frame began a turn (a carrying
    ///   `running` frame whose value was true) — clears any stale completion
    ///   flag from a previous turn.
    ///
    /// `running`, `questions` and the streaming-tail MINT are NOT handled here:
    /// they are read straight from the accumulated snapshot / seeded in the
    /// store. The store mints a tail id whenever a running turn has none, which
    /// subsumes the old per-frame mint edge (BET-668 review cycle 3).
    static func applying(
        frameTurnComplete: Bool?,
        frameStartedRunning: Bool,
        to state: ChatStreamTurnState
    ) -> ChatStreamTurnState {
        var s = state
        if let t = frameTurnComplete { s.turnComplete = t }
        if frameStartedRunning { s.turnComplete = false }
        // Reset the tail identity only on a genuine completion edge.
        if frameTurnComplete == true {
            s.streamingTailID = ""
        }
        return s
    }

    /// State after a FAILED `send()`: the optimistic running/tail is rolled
    /// back so the UI doesn't sit on a forever-spinner. The user's prompt is
    /// NOT lost — the caller restores the input text — so this only clears the
    /// fake "in progress" flags, leaving the question tombstones untouched.
    static func afterSendFailure(to state: ChatStreamTurnState) -> ChatStreamTurnState {
        var s = state
        s.running = false
        s.turnComplete = false
        s.streamingTailID = ""
        return s
    }
}

/// Which per-frame lifecycle facts the most recently applied stream frame
/// carried, derived from the routing `sub` and whether it targeted this
/// session. Used to separate the frame's DELTA from the accumulated snapshot
/// (which is sticky across turns).
struct ChatStreamFrameCarried: Equatable {
    /// True when this frame carried a running value (the `running` or
    /// `turnComplete` sub).
    var running: Bool
    /// True when this frame carried a completion flag (the `turnComplete` sub).
    var turnComplete: Bool
}

enum ChatStreamDelta {
    /// The carried facts of the most recently applied frame. A non-carrying
    /// sub, or a frame aimed at a different session, yields neither flag —
    /// so a republish that isn't a genuine turn-state frame (e.g. a retire or
    /// a foreign-session frame) can't apply a stale value.
    static func carried(sessionIsTarget: Bool, sub: String?) -> ChatStreamFrameCarried {
        guard sessionIsTarget else {
            return ChatStreamFrameCarried(running: false, turnComplete: false)
        }
        switch sub {
        case "running", "turnComplete":
            return ChatStreamFrameCarried(running: true, turnComplete: sub == "turnComplete")
        default:
            return ChatStreamFrameCarried(running: false, turnComplete: false)
        }
    }
}

/// A prompt accepted while a turn was running, held until the session goes
/// idle. Carries everything `send()` needs so the drain replays it verbatim.
struct QueuedPrompt: Equatable {
    let text: String
    let attachments: [SendPromptInput.Attachment]
    let model: SendPromptInput.Model?
    let mentions: [SendPromptInput.Mention]?
}

@MainActor
final class ChatSessionStore: ObservableObject {

    @Published private(set) var transcript: [TranscriptBlock] = []
    @Published private(set) var inProgressText = ""
    @Published private(set) var blocks: [TranscriptBlock] = []
    /// The same transcript as `blocks`, but wrapped in `TranscriptRow` with a
    /// STABLE id (see `TranscriptRow`). Kept so the subagent screen (and
    /// anything else) can keep using `blocks` unchanged.
    @Published private(set) var rows: [TranscriptRow] = []
    /// MessagingUI's incremental data source over `blocks`. Mutated IN PLACE
    /// via `apply` so its `id` stays stable and TiledView coalesces each turn's
    /// change as a prepend (loadEarlier) / append (streaming tail) / update
    /// rather than a full reload — which is what preserves scroll position.
    @Published private(set) var dataSource: ListDataSource<TranscriptRow> = ListDataSource()
    @Published private(set) var running = false
    @Published private(set) var turnComplete = false
    @Published private(set) var context: StreamContextPayload?
    @Published private(set) var cache: StreamCachePayload?
    @Published private(set) var truncation: StreamTruncationPayload?
    @Published private(set) var sessionError: StreamSessionErrorPayload?
    @Published private(set) var todos: StreamTodosPayload?
    @Published private(set) var questions: [QuestionRequest] = []
    @Published private(set) var permissions: [PermissionRequest] = []
    @Published private(set) var subagents: [StreamSubagentPayload] = []
    /// Live tools currently running on the box, in start order (BET-753). The
    /// chat renders each as a running-tool row with its live bash tail; a tool
    /// leaves the set the moment its `toolEnded` frame lands, and the canonical
    /// turn-boundary refetch renders it as a step row.
    @Published private(set) var runningTools: [LiveTool] = []
    @Published private(set) var childStores: [String: ChatSessionStore] = [:]
    /// Prompts accepted mid-turn, FIFO. Drained one per idle edge — never
    /// POSTed while `running`, which is what used to implicitly abort the
    /// in-flight turn.
    @Published private(set) var queuedPrompts: [QueuedPrompt] = []
    @Published private(set) var loading = false
    @Published private(set) var loadFailed = false
    /// True while the box was connected and the stream dropped (mirrors
    /// MantaEventStore.degraded). Drives the chat screen's "Connection lost —
    /// reconnecting…" banner so an offline hit does not read as "the model is
    /// quiet". Consumed only; reconnect machinery is owned by the event store.
    @Published private(set) var degraded = false
    /// A one-shot user-facing message bus for failed chat actions: views set it,
    /// the composer surfaces it through its existing hint capsule and clears it.
    /// It is deliberately settable from views because it is a bus, not store
    /// state — a failed abort/compact/clear/fork/delete must not fail silently.
    @Published var actionHint: String?
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
    private var runningSince: Date?
    /// Stable id for the streaming `.prose` tail, fixed for the life of one
    /// turn. The tail's TEXT grows every delta, so a content-derived id would
    /// change each time and thrash TiledView; this id doesn't. Reset when the
    /// turn ends and the tail is absorbed into the canonical transcript.
    private(set) var streamingTailID: String = ""
    /// The row id the streaming tail actually ships in. Unlike `streamingTailID`
    /// (which the stream merge resets the moment a `turnComplete` frame lands),
    /// this id SURVIVES the settle until the canonical refetch absorbs the tail
    /// — so TiledView sees the tail row turn into the canonical prose block as
    /// an in-place UPDATE instead of a remove+insert blink at the turn boundary
    /// (BET-752 task 2, giving prose the stable-identity treatment BET-666 gave
    /// step rows — BET-666, `TranscriptComponents.swift`).
    private var liveTailRowID = ""
    /// True while the previous rebuild shipped a live tail, so the empty branch
    /// of `rebuildBlocks` knows a settle/absorption just replaced it (and can
    /// carry the tail id onto the new canonical row) rather than mistaking a
    /// fresh `send()`'s pre-stream emptiness for an absorption.
    private var wasRenderingTail = false
    /// Question ids the user answered/rejected on-device. The incoming stream
    /// keeps publishing an answered question until the box catches up, so this
    /// tombstone set filters it out locally in the meantime (BET-668); an id
    /// leaves the set once the box stops publishing it.
    private var locallyAnsweredQuestionIDs: Set<String> = []
    /// True between `send()` and the box's first running acknowledgment. While
    /// set, the snapshot's accumulated `running` (still the previous turn's
    /// `false`) must not clobber the optimistic `true` — but once the box
    /// reports running at all, the snapshot is authoritative.
    private var optimisticRunning = false
    private var didRunOnce = false
    /// Test seams (internal, readable via `@testable`): count one-time vs
    /// resumable work so tests can assert the split without touching live
    /// timers or the network.
    private(set) var transcriptFetchCount = 0
    private var lastRunning: Bool?
    private var lastComplete: Bool?
    /// Monotonic count of FULL turned completions (BET-752 task 5). Increments
    /// at most once per turn: a multi-message turn emits a `turnComplete`
    /// frame per `message.updated`, so the raw `turnComplete` value flaps
    /// true repeatedly; the view used to fire a success haptic on every
    /// false→true edge. The store now coalesces those into ONE completion per
    /// turn, re-armed only when a genuinely new turn begins (a running start,
    /// or a `send()`). The view fires the haptic off this counter instead.
    @Published private(set) var turnCompletionCount = 0
    /// True until the current turn's completion has been counted once; re-armed
    /// when a new turn begins. Until a new turn, further `turnComplete` edges
    /// of the same turn are ignored (deduped per turn).
    private var completionArmed = true
    /// The permissions payload most recently folded into `permissions`. The
    /// accumulated snapshot is sticky and this sink fires on every stream change,
    /// so applying it unconditionally would clobber whatever `refreshPermissions()`
    /// (seed/resync) just wrote. Edge-triggering on the VALUE — rather than on the
    /// frame stamp, a single slot that a later frame or a transcript retirement can
    /// overwrite before this deferred sink reads it — applies every genuine
    /// permissions frame exactly once and nothing else.
    private var lastAppliedPermissions: StreamPermissionsPayload?
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

        // Per-session subscription (BET-672): sink on THIS session's state
        // alone, filtered to distinct values. The whole-dictionary sink used to
        // fire on every stream frame of ANY session — including backgrounded
        // ones — so every flush elsewhere in the box forced a full
        // `applyStreamState` → `rebuildBlocks` transcript re-map in the open
        // chat. `MantaSessionStreamState` is value-typed and derives
        // `Equatable`, so `removeDuplicates()` on the mapped per-session value
        // emits only when THIS session's state actually changes.
        eventStore.$sessionStates
            .receive(on: DispatchQueue.main)
            .compactMap { $0[sessionId] }
            .removeDuplicates()
            .sink { [weak self] _ in self?.applyStreamState() }
            .store(in: &cancellables)

        eventStore.$connectionState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in self?.handleConnection(state) }
            .store(in: &cancellables)

        // Degraded state feeds the chat banner; distinct values only, so a
        // republished identical value does not re-render the banner.
        eventStore.$degraded
            .removeDuplicates()
            .sink { [weak self] d in self?.degraded = d }
            .store(in: &cancellables)
    }

    // MARK: - Lifecycle

    /// Begin loading the session. One-time setup is split from resumable work:
    /// the initial transcript fetch runs once under the `didRunOnce` guard, so
    /// a subagent push (`stop`) then pop (`start`) does not re-fetch.
    func start() {
        if !didRunOnce {
            didRunOnce = true
            load()
        }
        // Register as an observer so the event store knows a consumer is
        // attached (BET-672): a session it completes with NO observer has its
        // accumulated stream chunks evicted to bound memory.
        eventStore.registerSession(sessionId)
    }

    func stop() {
        // The session is leaving the screen: it is no longer a consumer of
        // this session's stream chunks, and its subagent stores can all go
        // (BET-672). Dropping the dictionary here is the teardown-path half of
        // child-store eviction — the transcript-capped half runs per rebuild.
        eventStore.unregisterSession(sessionId)
        childStores.removeAll()
        // A queued prompt must never fire into a session the user has left.
        queuedPrompts.removeAll()
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

        // Fields that are copied straight through from the latest frame (the
        // stream is the single writer for these — no optimistic value to
        // protect).
        context = s.context
        cache = s.cache
        truncation = s.truncation
        sessionError = s.sessionError
        todos = s.todos
        subagents = s.subagents
        runningTools = s.runningTools

        // Which frame (if any) just changed this session's stream state. The
        // `$sessionStates` sink fires on every republish, so the stamp only
        // counts when it names THIS session; retirement nulls it so a stale
        // frame never replays over optimistic state.
        let stamp = eventStore.lastStreamFrame
        let carried = ChatStreamDelta.carried(sessionIsTarget: stamp?.sessionId == sessionId, sub: stamp?.sub)

        // --- running: the accumulated snapshot is authoritative, seeded when
        // a session is opened (a mid-turn session shows its working indicator),
        // EXCEPT the optimistic `true` `send()` just set — which the snapshot's
        // stale previous-turn `false` must not clobber while the box hasn't yet
        // confirmed. Reading the snapshot (not a per-frame stamp) also makes
        // this robust to frames that coalesce between publishes.
        if optimisticRunning, (carried.running || s.running == true) {
            optimisticRunning = false
        }
        running = optimisticRunning ? true : (s.running == true)

        // --- questions: the accumulated snapshot's pending questions, filtered
        // against the tombstone set (so an answered/rejected card is held until
        // the box catches up) and aged only when an actual payload exists.
        // Seeded on open — a session with a question already waiting shows its
        // card immediately.
        if let questionPayload = s.questions {
            let incoming = questionPayload.questions
            locallyAnsweredQuestionIDs.formIntersection(Set(incoming.map(\.id)))
            questions = incoming.filter { !locallyAnsweredQuestionIDs.contains($0.id) }
        }

        // --- permissions: live updates ride the interpreted stream. Unlike
        // questions there is no locally-answered tombstone filter — instead
        // the payload is edge-triggered against `lastAppliedPermissions`
        // (see its doc comment for why the frame stamp alone is not a safe
        // trigger). Applying it unconditionally would clobber whatever
        // `refreshPermissions()` just repaired on reconnect and briefly
        // resurrect an answered permission before its `permission.replied`
        // frame lands; gating on the stamp instead can silently DROP a
        // genuine permissions frame if a later frame or a transcript
        // retirement overwrites the stamp before this deferred sink reads
        // it. Edge-triggering on the value has neither failure mode.
        if let p = s.permissions, p != lastAppliedPermissions {
            lastAppliedPermissions = p
            permissions = p.permissions
        }

        // --- the turn lifecycle (`turnComplete` flag + streaming-tail RESET)
        // is per-frame: only a genuine `turnComplete` frame clears the tail.
        // `running` and `questions` are NOT touched by this merge (handled
        // above), and neither is the tail MINT (handled below).
        let frameStartedRunning = carried.running && (s.running == true)
        let merged = ChatStreamMerge.applying(
            frameTurnComplete: carried.turnComplete ? s.turnComplete : nil,
            frameStartedRunning: frameStartedRunning,
            to: ChatStreamTurnState(
                running: running,
                turnComplete: turnComplete,
                streamingTailID: streamingTailID,
                locallyAnsweredQuestionIDs: locallyAnsweredQuestionIDs,
                questions: questions
            )
        )
        turnComplete = merged.turnComplete
        streamingTailID = merged.streamingTailID
        // Seed a stable tail id whenever a running turn has none — however we
        // learned it is running: a fresh turn edge, a mid-turn session open
        // (seeded from the snapshot), or a stamp nulled between a running frame
        // and its deferred sink. A non-empty id is kept, so the streaming row
        // is never replaced mid-turn.
        if running, streamingTailID.isEmpty {
            streamingTailID = "live-\(sessionId)-\(UUID().uuidString)"
            liveTailRowID = streamingTailID
        }
        // runningSince tracks the turn that's running for the header timer.
        if running {
            if runningSince == nil { runningSince = Date() }
        } else {
            runningSince = nil
        }

        // The session just went idle (stream fold set `running = false`): any
        // queued prompt may now be sent. Guard-based, so firing on whichever
        // path folded running down is harmless — a second call is a no-op while
        // running (the drain's send sets it optimistically) or an empty queue.
        drainQueuedPromptIfIdle()

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

        // --- once-per-turn completion signal (BET-752 task 5). A multi-message
        // turn emits a `turnComplete` frame per `message.updated`, so the raw
        // false→true edge flaps several times in one turn — and the chat screen
        // used to fire a success haptic on EVERY edge. Coalesce to ONE
        // completion per TURN: count a fresh completion edge only while the
        // latch is armed, then disarm. `send()` re-arms it (a user submit IS a
        // new turn); the latch also starts armed, so a session opened mid-turn
        // still counts its first completion. The view fires the haptic off
        // `turnCompletionCount` instead of the raw `turnComplete` value.
        if completeChanged && turnComplete && completionArmed {
            turnCompletionCount += 1
            completionArmed = false
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
        // `uniqueTranscriptRows` (not a bare `stableScrollID` map) is
        // load-bearing: content-derived ids can collide across a long history,
        // and a duplicate id traps inside MessagingUI's diff the moment
        // `loadEarlier()` widens the window over the colliding pair.
        let newRows: [TranscriptRow]
        if inProgressText.isEmpty {
            // No live tail: the whole transcript is canonical. If the turn
            // that was streaming just settled and its refetch absorbed the
            // tail, carry the tail's STABLE id onto the canonical prose block
            // that replaced it — same-identity swap, so TiledView updates that
            // row in place instead of remove+insert-blinking at the boundary
            // (BET-752 task 2 — the prose analogue of BET-666's step rows).
            // Guarded on `wasRenderingTail`: `send()` mints `liveTailRowID`
            // before any text exists, and that optimistic no-tail state must
            // not rebadge the previous turn's last prose.
            var rows = uniqueTranscriptRows(transcript)
            if wasRenderingTail,
               !liveTailRowID.isEmpty,
               let lastProse = rows.lastIndex(where: {
                   if case .prose = $0.block { return true } else { return false }
               }) {
                rows[lastProse] = TranscriptRow(id: liveTailRowID, block: rows[lastProse].block)
                liveTailRowID = ""
            }
            wasRenderingTail = false
            blocks = transcript
            newRows = rows
        } else {
            // The live tail has no completion time yet — it gets one when the
            // turn ends and the canonical refetch replaces this block. The row
            // keeps `liveTailRowID` across the settle so it never blinks.
            wasRenderingTail = true
            blocks = transcript + [.prose(inProgressText, at: nil)]
            newRows = uniqueTranscriptRows(transcript)
                + [TranscriptRow(id: liveTailRowID, block: .prose(inProgressText, at: nil))]
        }
        rows = newRows
        // Mutate the data source in place (not `= ...`) so its identity — and
        // therefore TiledView's scroll position and cell state — survives.
        dataSource.apply(newRows)
        // Cap the subagent stores at the children the CURRENT transcript can
        // actually drill into; stores left over from a previous transcript no
        // longer show a row the user could open (BET-672).
        evictChildStores()
    }

    /// The child session ids present in the CURRENT transcript's subagent rows.
    /// The drill-in only ever happens from these rows, so they are exactly the
    /// set a live `childStores` needs to hold; anything else is a leak.
    private var childIDsInTranscript: Set<String> {
        var ids = Set<String>()
        for block in transcript {
            guard case .steps(let content) = block else { continue }
            let rows: [StepGroupRow]
            switch content {
            case .rows(let r): rows = r
            case .rollup(_, let r): rows = r
            }
            for row in rows {
                if case .subagent(let agent) = row, let id = agent.childSessionId, !id.isEmpty {
                    ids.insert(id)
                }
            }
        }
        return ids
    }

    private func evictChildStores() {
        guard !childStores.isEmpty else { return }
        let live = childIDsInTranscript
        for id in childStores.keys where !live.contains(id) {
            childStores.removeValue(forKey: id)
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
        transcriptFetchCount += 1
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
                    //
                    // Cover ONLY completed messages: a chunk may be retired only
                    // once its message is COMPLETE, because ChatTranscriptMapper
                    // skips an assistant message that is still in flight
                    // (`time.completed == nil`). opencode:messages returns the
                    // in-flight message with no `time.completed`, so naming it
                    // here would delete the only copy of the running turn's text
                    // — the transcript refuses to draw it — leaving the screen
                    // silent until the turn finishes.
                    if !didFail {
                        eventStore.retireCoveredStreamText(
                            sessionId: sessionId,
                            covered: Set(loaded.filter { $0.info.time?.completed != nil }.map(\.info.id))
                        )
                        inProgressText = eventStore.sessionStates[sessionId]?.liveText ?? ""
                    }
                    rebuildBlocks()
                }
            }
        } while fetchPending
    }

    // MARK: - Permissions (S1a answerable)

    /// Seed + resync only — live updates arrive on the interpreted stream;
    /// the 2.5s poll is gone.
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
        // opencode's /question/{id}/reply|reject accept ONLY the `que_…`
        // requestId — NOT the stable card id (a tool callID). Sending the card
        // id makes the box return HTTP 400 and the question never clears, so
        // the blocked turn stays blocked and the session looks dead to the
        // user. A transcript-recovered question has no requestId and is
        // unanswerable — drop the card locally rather than erroring.
        guard let requestId = request.requestId else {
            questions.removeAll { $0.id == request.id }
            return
        }
        // Drop the card optimistically and tombstone its id so the incoming
        // stream can't flash it back before the box catches up; restore both
        // on failure so a real send error doesn't silently leave the question
        // gone while the box stays blocked on it ("can't send messages").
        questions.removeAll { $0.id == request.id }
        locallyAnsweredQuestionIDs.insert(request.id)
        Task {
            do {
                try await api.questionReply(requestId: requestId, answers: answers, sessionId: sessionId)
            } catch {
                locallyAnsweredQuestionIDs.remove(request.id)
                if !questions.contains(where: { $0.id == request.id }) {
                    questions.append(request)
                }
            }
        }
    }

    func rejectQuestion(_ request: QuestionRequest) {
        guard let requestId = request.requestId else {
            questions.removeAll { $0.id == request.id }
            return
        }
        questions.removeAll { $0.id == request.id }
        locallyAnsweredQuestionIDs.insert(request.id)
        Task {
            do {
                try await api.questionReject(requestId: requestId, sessionId: sessionId)
            } catch {
                locallyAnsweredQuestionIDs.remove(request.id)
                if !questions.contains(where: { $0.id == request.id }) {
                    questions.append(request)
                }
            }
        }
    }

    // MARK: - Composer (S5 / BET-597)

    /// Send a prompt for this session. `text` needs no trimming here (the
    /// composer trims); attachments + model are optional and flow through the
    /// unchanged `opencode:prompt` surface.
    ///
    /// Returns `true` when the box accepted the prompt, `false` when the RPC
    /// failed. On failure the optimistic running/tail state is rolled back so
    /// the UI doesn't sit on a forever-spinner, and the caller is told so it
    /// can restore the user's typed text.
    @discardableResult
    func send(text: String, attachments: [SendPromptInput.Attachment], model: SendPromptInput.Model?, mentions: [SendPromptInput.Mention]? = nil) async -> Bool {
        // A send while the turn runs must not reach opencode — it would abort
        // the in-flight turn implicitly. Queue it; the idle edge drains FIFO.
        if running {
            queuedPrompts.append(QueuedPrompt(text: text, attachments: attachments, model: model, mentions: mentions))
            return true
        }
        // Echo the message straight into the transcript and assume the turn is
        // running. The box confirms both within a second (running frame, then
        // the canonical refetch replaces this block), but without the echo the
        // screen sits completely unchanged after a send, which reads as "the
        // send did nothing".
        var optimisticUserIndex: Int?
        if !text.isEmpty {
            optimisticUserIndex = transcript.count
            transcript.append(.user(text, at: Date()))
            rebuildBlocks()
        }
        running = true
        optimisticRunning = true
        turnComplete = false
        // A user submit is a genuinely new turn: re-arm the one-per-turn
        // completion latch so this turn's completion is counted once (BET-752
        // task 5).
        completionArmed = true
        sessionError = nil
        if runningSince == nil {
            runningSince = Date()
            // A send starts a turn directly (no stream running transition to
            // mint this from), so mint the streaming tail's stable id here too.
            streamingTailID = "live-\(sessionId)-\(UUID().uuidString)"
            liveTailRowID = streamingTailID
        }
        do {
            try await api.sendPrompt(SendPromptInput(
                sessionId: sessionId,
                text: text,
                model: model,
                attachments: attachments.isEmpty ? nil : attachments,
                mentions: mentions
            ))
            return true
        } catch {
            // Surface the failure instead of swallowing it: stop the running
            // state and clear the optimistic tail so the spinner doesn't stay
            // on forever, and let the caller restore the lost message.
            optimisticRunning = false
            let rolledBack = ChatStreamMerge.afterSendFailure(to: ChatStreamTurnState(
                running: running,
                turnComplete: turnComplete,
                streamingTailID: streamingTailID,
                locallyAnsweredQuestionIDs: locallyAnsweredQuestionIDs,
                questions: questions
            ))
            running = rolledBack.running
            turnComplete = rolledBack.turnComplete
            streamingTailID = rolledBack.streamingTailID
            // Remove THIS send's optimistic echo: the box never received the
            // message, so it belongs back in the composer input (which the
            // caller restores), not standing in the transcript as if sent.
            // `fetchTranscript` can replace the whole array, so guard on the
            // captured index still holding our echo before removing it.
            if let idx = optimisticUserIndex, idx < transcript.count,
               case .user(let echoed, _) = transcript[idx], echoed == text {
                transcript.remove(at: idx)
                rebuildBlocks()
            }
            return false
        }
    }

    /// Drain ONE queued prompt now that the session is idle. One per edge: the
    /// send() below sets `running = true` optimistically, so a second queued
    /// item waits for the next idle. Strict FIFO.
    private func drainQueuedPromptIfIdle() {
        guard !running, !queuedPrompts.isEmpty else { return }
        let next = queuedPrompts.removeFirst()
        Task { @MainActor in
            let ok = await send(text: next.text, attachments: next.attachments, model: next.model, mentions: next.mentions)
            if !ok {
                // The send failed after the box accepted going idle — don't lose
                // the prompt silently. Put it back at the FRONT and tell the user.
                queuedPrompts.insert(next, at: 0)
                actionHint = "Queued message failed to send — will retry on next turn"
            }
        }
    }

    /// Interrupt the running turn (voice `abort`).
    func abort() {
        Task {
            do { try await api.abort(sessionId: sessionId) }
            catch { await MainActor.run { actionHint = "Couldn't stop the turn — check the connection" } }
        }
    }

    /// Compact the session to free context (voice `compact`).
    ///
    /// Compact used to fire blind — no confirmation and no feedback that context
    /// was freed. Both the overflow action (now confirm-gated) and the voice
    /// `compact` route here, and both surface the outcome through the composer
    /// `actionHint` bus so a compact is never silent:
    /// - success surfaces "Compacted — context freed" and schedules the store's
    ///   standard refresh, so the next `context` frame the box pushes shows the
    ///   new headroom in the header pill (the `pct` arrives by push on
    ///   `session.next.step.ended`, so it reflects the freed context once the
    ///   conversation resumes);
    /// - failure surfaces "Compact failed — check the connection".
    func compact() {
        Task {
            do {
                try await api.compactSession(sessionId: sessionId)
                await MainActor.run {
                    actionHint = "Compacted — context freed"
                    scheduleRefetch()
                }
            } catch {
                await MainActor.run { actionHint = "Compact failed — check the connection" }
            }
        }
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
}
